import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, request as httpRequest, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createApp } from "./server.ts";
import { BookmarkService } from "./bookmarks.ts";
const bookmarkFixture = (id: number) => ({
  id,
  url: `https://example.com/${id}`,
  title: `Article ${id}`,
  description: "Description",
  notes: "Personal note",
  tag_names: ["existing"],
  is_archived: false,
  unread: false,
  shared: false,
  date_added: "2026-11-01",
  date_modified: "2026-11-01",
});
import { createVerifier } from "./auth.ts";
import { MediaService } from "./media.ts";
import { HomeService, homePolicySchema } from "./home.ts";

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
    } else if (req.url?.startsWith("/api/v3/movie/lookup?")) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify([
          {
            id: 0,
            title: "Test Movie",
            year: 2020,
            tmdbId: 100,
            images: [
              {
                coverType: "poster",
                remoteUrl: "https://image.tmdb.org/t/p/w500/test.jpg",
              },
            ],
          },
        ]),
      );
    } else if (req.url?.startsWith("/api/v3/queue?")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ totalRecords: 0, records: [] }));
    } else if (req.url === "/api/v3/movie") {
      res.setHeader("Content-Type", "application/json");
      res.end("[]");
    } else if (req.url === "/api/v3/qualityprofile") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify([{ id: 1, name: "HD" }]));
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
    new HomeService(
      {
        url: "http://127.0.0.1:8123",
        token: "fixture-home",
        entities: [
          homePolicySchema.parse({
            entityId: "light.hall",
            actions: ["turn_on", "turn_off"],
          }),
        ],
      },
      async () =>
        Response.json({
          entity_id: "light.hall",
          state: "off",
          attributes: { supported_color_modes: ["onoff"] },
        }),
    ),
    new BookmarkService(
      {
        url: "http://127.0.0.1:9094",
        ownerSubject: "leo-id",
        token: "a".repeat(40),
      },
      async (url, init) => {
        assert.equal(
          (init?.headers as Record<string, string>).Authorization,
          `Token ${"a".repeat(40)}`,
        );
        if (new URL(String(url)).pathname === "/api/bookmarks/")
          return Response.json({ count: 1, results: [bookmarkFixture(1)] });
        return new URL(String(url)).pathname === "/api/bookmarks/1/"
          ? Response.json(bookmarkFixture(1))
          : new Response(null, { status: 404 });
      },
    ),
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
    .setSubject(typeof overrides.sub === "string" ? overrides.sub : "leo-id")
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
  assert.deepEqual(scopes, [
    "openid",
    "groups",
    "documents:read",
    "documents:ingest",
    "lab:read",
    "media:read",
    "media:request",
    "home:read",
    "home:control",
    "bookmarks:read",
    "bookmarks:write",
  ]);
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
      /scope="openid groups documents:read documents:ingest lab:read media:read media:request home:read home:control bookmarks:read bookmarks:write"/,
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
    "control_home_entities",
    "get_bookmark",
    "get_download_progress",
    "get_home_entity",
    "get_media_details",
    "request_media",
    "save_bookmark",
    "search_bookmarks",
    "search_home_entities",
    "search_media",
    "whoami",
  ]);
  for (const tool of tools.tools)
    assert.equal(tool.outputSchema.type, "object");
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

test("MCP delivers rich structured results matching JSON text and limits action hints to the caller's permissions", async () => {
  const rpc = async (scope: string, name: string, args: unknown) => {
    const response = await request("/mcp", await token({ scope }), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const data = raw.startsWith("event:")
      ? JSON.parse(raw.split("data: ")[1].split("\n")[0])
      : JSON.parse(raw);
    assert.equal(data.error, undefined, raw);
    assert(!data.result.isError, raw);
    assert.deepEqual(
      JSON.parse(data.result.content[0].text),
      data.result.structuredContent,
    );
    return data.result.structuredContent;
  };
  const search = await rpc("media:read", "search_media", {
    query: "Test",
    type: "movie",
  });
  assert.equal(
    search.results[0].images.poster.url,
    "https://image.tmdb.org/t/p/w500/test.jpg",
  );
  assert.equal(search.results[0].availableActions[0].tool, "get_media_details");
  const readOnly = await rpc("media:read", "get_media_details", {
    mediaId: "movie:tmdb:100",
  });
  assert.equal(readOnly.canRequest, true);
  assert.deepEqual(readOnly.availableActions, []);
  const writable = await rpc("media:read media:request", "get_media_details", {
    mediaId: "movie:tmdb:100",
  });
  assert.deepEqual(writable.availableActions[0], {
    id: "request_movie",
    tool: "request_media",
    requiredScope: "media:request",
    arguments: { mediaId: "movie:tmdb:100", qualityProfile: "HD" },
  });
});

test("home scopes, structured state results, tool schema and control enforcement", async () => {
  const rpc = async (scope: string, method: string, params: unknown) =>
    request("/mcp", await token({ scope }), {
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
  const parse = async (response: Response) => {
    const text = await response.text();
    return text.startsWith("event:")
      ? JSON.parse(text.split("data: ")[1].split("\n")[0])
      : JSON.parse(text);
  };
  const listed = await parse(await rpc("home:read", "tools/list", {}));
  const control = listed.result.tools.find(
    (t: { name: string }) => t.name === "control_home_entities",
  );
  assert.equal(control.inputSchema.type, "object");
  assert(control.inputSchema.properties.entityIds);
  assert(control.inputSchema.properties.action);
  assert(control.inputSchema.properties.percent);
  const read = await rpc("home:read", "tools/call", {
    name: "get_home_entity",
    arguments: { entityId: "light.hall" },
  });
  assert.equal(read.status, 200);
  const result = (await parse(read)).result;
  assert.equal(result.structuredContent.entity.state, "off");
  assert.deepEqual(result.structuredContent.entity.availableControls, []);
  assert.deepEqual(
    JSON.parse(result.content[0].text),
    result.structuredContent,
  );
  const denied = await rpc("home:read", "tools/call", {
    name: "control_home_entities",
    arguments: { entityIds: ["light.hall"], action: "turn_off" },
  });
  assert.equal(denied.status, 403);
  const media = await rpc("media:request", "tools/call", {
    name: "get_home_entity",
    arguments: { entityId: "light.hall" },
  });
  assert.equal(media.status, 403);
  const accepted = await rpc("home:control", "tools/call", {
    name: "control_home_entities",
    arguments: { entityIds: ["light.hall"], action: "turn_off" },
  });
  assert.equal(accepted.status, 200);
  assert.equal(
    (await parse(accepted)).result.structuredContent.outcome,
    "already_satisfied",
  );
});

test("download progress requires media read scope and returns the structured output contract", async () => {
  const call = async (scope: string) =>
    request("/mcp", await token({ scope }), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_download_progress", arguments: {} },
    });
  assert.equal((await call("media:request")).status, 403);
  const response = await call("media:read");
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = text.startsWith("event:")
    ? JSON.parse(text.split("data: ")[1].split("\n")[0])
    : JSON.parse(text);
  assert.equal(data.result.structuredContent.sources.length, 2);
  assert.deepEqual(data.result.structuredContent.errors, []);
  assert.deepEqual(
    JSON.parse(data.result.content[0].text),
    data.result.structuredContent,
  );
});

test("bookmark tools enforce the owner subject even with valid bookmark scopes", async () => {
  async function call(
    subject: string,
    scope: string,
    name: string,
    args: unknown,
  ) {
    return request("/mcp", await token({ sub: subject, scope }), {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name, arguments: args },
    });
  }
  async function result(response: Response) {
    assert.equal(response.status, 200);
    const raw = await response.text();
    return (
      raw.startsWith("event:")
        ? JSON.parse(raw.split("data: ")[1].split("\n")[0])
        : JSON.parse(raw)
    ).result;
  }
  const found = await result(
    await call("leo-id", "bookmarks:read", "search_bookmarks", {}),
  );
  assert.equal(found.structuredContent.bookmarks[0].bookmarkId, 1);
  const missing = await result(
    await call("leo-id", "bookmarks:read", "get_bookmark", { bookmarkId: 2 }),
  );
  assert.match(missing.content[0].text, /bookmark_not_found/);
  for (const subject of ["other-id", "unbound-id"]) {
    for (const [scope, name, args] of [
      ["bookmarks:read", "search_bookmarks", {}],
      ["bookmarks:read", "get_bookmark", { bookmarkId: 1 }],
      ["bookmarks:write", "save_bookmark", { url: "https://example.com" }],
    ] as const) {
      const denied = await result(await call(subject, scope, name, args));
      assert(denied.isError);
      assert.match(denied.content[0].text, /bookmarks_forbidden/);
    }
  }
  assert.equal(
    (
      await call("leo-id", "bookmarks:read", "save_bookmark", {
        url: "https://example.com",
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("leo-id", "bookmarks:write", "search_bookmarks", {})).status,
    403,
  );
});
