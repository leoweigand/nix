import { createServer, type IncomingMessage } from "node:http";
import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { z } from "zod";
import { getLabStatus, type Check } from "./status.ts";

export interface Config {
  resource: string;
  issuer: string;
  checks: Check[];
}

export function createApp(
  config: Config,
  verify: (token: string) => Promise<AuthInfo>,
) {
  const canonical = new URL(config.resource);
  const metadataUrl = `${canonical.origin}/.well-known/oauth-protected-resource${canonical.pathname}`;
  const mcp = createMcpHandler(
    ({ authInfo }) => {
      if (!authInfo) throw new Error("Missing authenticated context");
      const server = new McpServer({ name: "leolab", version: "0.1.0" });
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
            "Show the verified OAuth subject, client, and granted scopes. No credentials are returned.",
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
      server.registerTool(
        "get_lab_status",
        {
          description:
            "Check fixed Picard service endpoints. Reports process/HTTP health, not end-to-end inference or notification delivery. No input is required.",
          inputSchema: z.object({}).strict(),
          annotations,
        },
        async () => {
          const started = performance.now();
          const output = await getLabStatus(config.checks);
          audit(
            "get_lab_status",
            started,
            output.healthy ? "healthy" : "degraded",
          );
          return {
            content: [{ type: "text", text: JSON.stringify(output) }],
            structuredContent: output,
          };
        },
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
          scopes_supported: ["lab:read"],
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
      if (!req.auth.scopes.includes("lab:read")) {
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
      const deadline = setTimeout(() => res.destroy(), 15_000);
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
