import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createApp } from "./server.ts";
import { createVerifier } from "./auth.ts";
import { getLabStatus } from "./status.ts";

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
      checks: [
        {
          name: "gateway",
          url: `${upstreamBase}/health`,
          expectedStatus: 204,
          verifies: "process health",
        },
      ],
    },
    createVerifier(issuer, resource, `${upstreamBase}/jwks`),
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
});
test("rejects invalid, expired, wrong-audience and ID tokens", async () => {
  for (const value of [
    "garbage",
    await token({ exp: 1 }),
    await token({ aud: "https://other.example" }),
    await token({}, "JWT"),
  ]) {
    assert.equal((await request("/mcp", value)).status, 401);
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
    "get_lab_status",
    "whoami",
  ]);
  const identity = await rpc("tools/call", { name: "whoami", arguments: {} });
  assert.equal(identity.structuredContent.subject, "leo-id");
  assert.equal(identity.structuredContent.clientId, "codex");
  assert(!JSON.stringify(identity).includes(accessToken));
  const status = await rpc("tools/call", {
    name: "get_lab_status",
    arguments: {},
  });
  assert.equal(status.structuredContent.healthy, true);
  const bad = await rpc("tools/call", {
    name: "get_lab_status",
    arguments: { url: "http://evil.test" },
  });
  assert.equal(bad.isError, true);
});
test("health checks distinguish HTTP failure, redirects, timeout and bad discovery", async () => {
  const result = await getLabStatus(
    [
      {
        name: "ok",
        url: `${upstreamBase}/health`,
        expectedStatus: 204,
        verifies: "process",
      },
      {
        name: "failed",
        url: `${upstreamBase}/failed`,
        expectedStatus: 204,
        verifies: "process",
      },
      {
        name: "redirect",
        url: `${upstreamBase}/redirect`,
        expectedStatus: 204,
        verifies: "process",
      },
      {
        name: "slow",
        url: `${upstreamBase}/slow`,
        expectedStatus: 204,
        verifies: "process",
      },
      {
        name: "bad-discovery",
        url: `${upstreamBase}/jwks`,
        expectedStatus: 200,
        verifies: "discovery",
        issuer,
      },
    ],
    100,
  );
  assert.deepEqual(
    result.services.map((x) => x.status),
    ["healthy", "unhealthy", "unhealthy", "unreachable", "unhealthy"],
  );
  assert.equal(result.services[3].reason, "timeout");
});
