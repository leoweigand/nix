import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createApp } from "./server.ts";
import { createVerifier } from "./auth.ts";
import { MediaService } from "./media.ts";

const resource = "https://mcp.example.test/mcp";
const issuer = "https://auth.example.test";
const keys = await generateKeyPair("RS256");
const jwk = await exportJWK(keys.publicKey);
let app: ReturnType<typeof createApp>;
let upstream: Server;
let base: string;
let upstreamBase: string;
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
before(async () => {
  upstream = createServer((req, res) => {
    if (req.url === "/jwks") {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] }),
      );
    } else if (req.url === "/health") {
      res.writeHead(204);
      res.end();
    } else if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/health" });
      res.end();
    } else if (req.url === "/slow") {
      /* client timeout closes this connection */
    } else {
      res.writeHead(503);
      res.end();
    }
  });
  upstreamBase = await listen(upstream);
  app = createApp(
    {
      resource,
      issuer,
    },
    createVerifier(issuer, resource, `${upstreamBase}/jwks`),
    new MediaService({
      sonarr: { url: upstreamBase, apiKey: "fixture", rootFolder: "/tv" },
      radarr: { url: upstreamBase, apiKey: "fixture", rootFolder: "/movies" },
    }),
  );
  base = await listen(app.server);
});
after(async () => {
  await app.close();
  app.server.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([
    new Promise<void>((resolve) => app.server.close(() => resolve())),
    new Promise<void>((resolve) => upstream.close(() => resolve())),
  ]);
});
async function token(overrides: Record<string, unknown> = {}, typ = "at+jwt") {
  return new SignJWT({ client_id: "codex", scope: "lab:read", ...overrides })
    .setProtectedHeader({ alg: "RS256", kid: "test", typ })
    .setIssuer(issuer)
    .setAudience(typeof overrides.aud === "string" ? overrides.aud : resource)
    .setSubject("leo-id")
    .setJti("unique-test")
    .setIssuedAt()
    .setExpirationTime(typeof overrides.exp === "number" ? overrides.exp : "5m")
    .sign(keys.privateKey);
}
function request(
  path: string,
  accessToken?: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return new Promise<Response>((resolve, reject) => {
    const req = httpRequest(
      `${base}${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Host: "mcp.example.test",
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...extra,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve(
            new Response(
              res.statusCode === 204 ? null : Buffer.concat(chunks),
              {
                status: res.statusCode,
                headers: res.headers as Record<string, string>,
              },
            ),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
test("OAuth discovery is available and unauthenticated calls receive a challenge", async () => {
  const metadata = await (
    await request("/.well-known/oauth-protected-resource/mcp")
  ).json();
  assert.equal(metadata.resource, resource);
  const response = await request("/mcp");
  assert.equal(response.status, 401);
  assert.match(
    response.headers.get("www-authenticate")!,
    /resource_metadata=.*oauth-protected-resource\/mcp/,
  );
  const scopes = response.headers
    .get("www-authenticate")!
    .match(/scope="([^"]+)"/)![1]
    .split(" ");
  assert.deepEqual(scopes, ["lab:read", "media:read", "media:request"]);
  assert.deepEqual(metadata.scopes_supported, scopes);
});
test("rejects invalid, expired, wrong-audience and ID tokens", async () => {
  for (const value of [
    "garbage",
    await token({ exp: 1 }),
    await token({ aud: "https://other.example" }),
    await token({}, "JWT"),
  ]) {
    const response = await request("/mcp", value);
    assert.equal(response.status, 401);
    assert.match(
      response.headers.get("www-authenticate")!,
      /scope="lab:read media:read media:request"/,
    );
  }
  assert.equal(
    (await request("/mcp", await token({ scope: "other:read" }))).status,
    403,
  );
});
test("validates host and origin before serving requests", async () => {
  assert.equal(
    (await request("/healthz", undefined, undefined, { Host: "evil.test" }))
      .status,
    421,
  );
  assert.equal(
    (
      await request("/healthz", undefined, undefined, {
        Origin: "https://evil.test",
      })
    ).status,
    403,
  );
});
test("authenticated MCP handshake, tool discovery and calls", async () => {
  const accessToken = await token();
  const rpc = async (method: string, params: unknown = {}) => {
    const response = await request("/mcp", accessToken, {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const data = text.startsWith("event:")
      ? JSON.parse(text.split("data: ")[1].split("\n")[0])
      : JSON.parse(text);
    assert.equal(data.error, undefined, text);
    return data.result;
  };
  const init = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(init.serverInfo.name, "leolab");
  const tools = await rpc("tools/list");
  assert.deepEqual(tools.tools.map((x: { name: string }) => x.name).sort(), [
    "get_media_details",
    "request_media",
    "search_media",
    "whoami",
  ]);
  const identity = await rpc("tools/call", { name: "whoami", arguments: {} });
  assert.equal(identity.structuredContent.subject, "leo-id");
  assert.equal(identity.structuredContent.clientId, "codex");
  assert(!JSON.stringify(identity).includes(accessToken));
  const denied = await request("/mcp", accessToken, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "request_media", arguments: { mediaId: "movie:tmdb:100" } },
  });
  assert.equal(denied.status, 403);
  assert.match(denied.headers.get("www-authenticate")!, /media:request/);
  const reader = await token({ scope: "media:read" });
  const readOnly = await request("/mcp", reader, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "request_media", arguments: { mediaId: "movie:tmdb:100" } },
  });
  assert.equal(readOnly.status, 403);
  const bad = await request("/mcp", await token({ scope: "media:request" }), {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: { name: "request_media", arguments: { mediaId: "tv:tvdb:200" } },
  });
  assert.equal(bad.status, 200);
  assert.match(await bad.text(), /isError/);
});
