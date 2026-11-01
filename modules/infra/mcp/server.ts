import { createServer, type IncomingMessage } from "node:http";
import {
  createMcpHandler,
  McpServer,
  requireScopes,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import {
  MediaService,
  MediaError,
  searchSchema,
  detailsSchema,
  requestSchema,
} from "./media.ts";

export interface Config {
  resource: string;
  issuer: string;
}

export function createApp(
  config: Config,
  verify: (token: string) => Promise<AuthInfo>,
  media: MediaService,
) {
  const canonical = new URL(config.resource);
  const metadataUrl = `${canonical.origin}/.well-known/oauth-protected-resource${canonical.pathname}`;
  const mcp = createMcpHandler(
    ({ authInfo }) => {
      if (!authInfo) throw new Error("Missing authenticated context");
      const server = new McpServer({ name: "leolab", version: "0.2.0" });
      const annotations = {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      };
      const audit = (tool: string, started: number, outcome: string) => {
        console.log(
          JSON.stringify({
            event: "tool_call",
            tool,
            subject: authInfo.extra?.subject,
            clientId: authInfo.clientId,
            durationMs: Math.round(performance.now() - started),
            outcome,
          }),
        );
      };
      server.registerTool(
        "whoami",
        {
          description:
            "Return the authenticated caller’s OAuth subject, client ID, issuer, and granted permissions. Does not expose credentials or change any state.",
          inputSchema: z.object({}).strict(),
          annotations,
        },
        async () => {
          const output = {
            subject: authInfo.extra?.subject,
            issuer: config.issuer,
            clientId: authInfo.clientId,
            scopes: authInfo.scopes,
          };
          audit("whoami", performance.now(), "success");
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        },
      );
      const run = async (
        tool: string,
        scope: string,
        operation: (signal: AbortSignal) => Promise<Record<string, unknown>>,
        info: Record<string, unknown> = {},
        cancelled?: AbortSignal,
      ) => {
        const started = performance.now();
        if (!authInfo.scopes.includes(scope))
          return {
            isError: true,
            content: [
              { type: "text" as const, text: `Missing permission: ${scope}` },
            ],
          };
        try {
          const output = await operation(
            AbortSignal.any([
              AbortSignal.timeout(45_000),
              ...(cancelled ? [cancelled] : []),
            ]),
          );
          console.log(
            JSON.stringify({
              event: "tool_call",
              tool,
              subject: authInfo.extra?.subject,
              clientId: authInfo.clientId,
              durationMs: Math.round(performance.now() - started),
              outcome: output.outcome ?? "success",
              ...info,
              ...(tool === "request_media"
                ? {
                    libraryChanged: output.libraryChanged,
                    searchStarted: output.searchStarted,
                    commandId: output.commandId,
                  }
                : {}),
            }),
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
            structuredContent: output,
            ...(["failed", "partial_failure"].includes(String(output.outcome))
              ? { isError: true }
              : {}),
          };
        } catch (error) {
          audit(tool, started, "failed");
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text:
                  error instanceof MediaError
                    ? error.code
                    : "invalid_backend_response",
              },
            ],
          };
        }
      };
      server.registerTool(
        "search_media",
        {
          description:
            "Search the movie and TV catalog by title. Returns matching titles with stable media IDs, release years, synopses, and current library status. Use these IDs with get_media_details or request_media. This searches for titles, not downloadable releases, and does not change the library.",
          inputSchema: searchSchema,
          annotations: { ...annotations, openWorldHint: true },
          scopeChallenge: requireScopes("media:read"),
        },
        async (input, ctx) =>
          run(
            "search_media",
            "media:read",
            (signal) => media.search(input, signal),
            {},
            ctx.mcpReq.signal,
          ),
      );
      server.registerTool(
        "get_media_details",
        {
          description:
            "Get details for a movie or TV show using a media ID returned by search_media. Returns library and monitoring status, available quality profiles, and—for TV—season numbers with aired, available, and missing episode counts. Use this before requesting media to resolve ambiguity and choose TV seasons. Does not change the library.",
          inputSchema: detailsSchema,
          annotations: { ...annotations, openWorldHint: true },
          scopeChallenge: requireScopes("media:read"),
        },
        async (input, ctx) =>
          run(
            "get_media_details",
            "media:read",
            (signal) => media.details(input.mediaId, signal),
            {},
            ctx.mcpReq.signal,
          ),
      );
      server.registerTool(
        "request_media",
        {
          description:
            "Request a movie or explicitly selected TV seasons through Radarr or Sonarr. Uses the HD quality profile unless another profile returned by get_media_details is specified. For TV, monitors and searches only episodes already aired in the selected seasons; does not enable future-episode monitoring. Preserves monitoring outside the selection and does not silently change an existing title’s quality profile. Repeated requests return the existing state or request missing selections. Reports whether changes were accepted and a download search started; acceptance does not mean media is downloading or available. May initiate downloads.",
          inputSchema: requestSchema,
          annotations: {
            ...annotations,
            readOnlyHint: false,
            openWorldHint: true,
          },
          scopeChallenge: requireScopes("media:request"),
        },
        async (input, ctx) =>
          run(
            "request_media",
            "media:request",
            (signal) => media.request(input, signal),
            input,
            ctx.mcpReq.signal,
          ),
      );
      return server;
    },
    {
      legacy: "stateless",
      responseMode: "auto",
      maxRequestBodySize: 64 * 1024,
      maxSubscriptions: 0,
    },
  );
  const handleMcp = toNodeHandler(mcp, { maxRequestBodySize: 64 * 1024 });
  let active = 0;
  const server = createServer(
    async (req: IncomingMessage & { auth?: AuthInfo }, res) => {
      res.setHeader("Cache-Control", "no-store");
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      // Caddy preserves the original host; never trust caller-supplied forwarding headers.
      if (req.headers.host !== canonical.host) {
        json(421, { error: "invalid_host" });
        return;
      }
      if (req.headers.origin && req.headers.origin !== canonical.origin) {
        json(403, { error: "invalid_origin" });
        return;
      }
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (
        req.method === "GET" &&
        [
          "/.well-known/oauth-protected-resource",
          `/.well-known/oauth-protected-resource${canonical.pathname}`,
        ].includes(req.url ?? "")
      ) {
        json(200, {
          resource: config.resource,
          authorization_servers: [config.issuer],
          scopes_supported: ["lab:read", "media:read", "media:request"],
          bearer_methods_supported: ["header"],
          resource_name: "LeoLab MCP",
        });
        return;
      }
      if (req.url !== canonical.pathname) {
        json(404, { error: "not_found" });
        return;
      }
      const authorization = req.headers.authorization;
      const match = authorization?.match(/^Bearer ([^\s]+)$/i);
      if (!match) {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="${metadataUrl}", scope="lab:read"`,
        );
        json(401, { error: "unauthorized" });
        return;
      }
      try {
        req.auth = await verify(match[1]);
      } catch {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer error="invalid_token", resource_metadata="${metadataUrl}"`,
        );
        json(401, { error: "invalid_token" });
        return;
      }
      if (
        !["lab:read", "media:read", "media:request"].some((scope) =>
          req.auth!.scopes.includes(scope),
        )
      ) {
        res.setHeader(
          "WWW-Authenticate",
          `Bearer error="insufficient_scope", scope="lab:read", resource_metadata="${metadataUrl}"`,
        );
        json(403, { error: "insufficient_scope" });
        return;
      }
      if (active >= 16) {
        res.setHeader("Retry-After", "1");
        json(429, { error: "busy" });
        return;
      }
      active++;
      const deadline = setTimeout(() => res.destroy(), 60_000);
      res.once("close", () => {
        clearTimeout(deadline);
        active--;
      });
      try {
        await handleMcp(req, res);
      } catch {
        if (!res.headersSent) json(500, { error: "internal_error" });
        else res.destroy();
      }
    },
  );
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  return { server, close: () => mcp.close() };
}
