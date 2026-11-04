import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createApp } from "./server.ts";
import { NowClient } from "./now.ts";
import { MediaService } from "./media.ts";
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
test("existing lab MCP provides Now tools with verified caller and separate read/write scopes", async () => {
  const calls: Array<{ subject: unknown; token: unknown; body: unknown }> = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push({
      subject: request.headers["x-now-subject"],
      token: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ apps: [] }));
  });
  const upstreamUrl = await listen(upstream);
  const resource = "https://mcp.test/mcp";
  const app = createApp(
    { resource, issuer: "https://id.test" },
    async (token) => ({
      token,
      clientId: "fixture",
      scopes: token === "reader" ? ["now:read"] : ["now:read", "now:write"],
      extra: { subject: "verified-alice" },
    }),
    new MediaService({
      sonarr: { url: upstreamUrl, apiKey: "fixture", rootFolder: "/tv" },
      radarr: { url: upstreamUrl, apiKey: "fixture", rootFolder: "/films" },
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    new NowClient({ url: upstreamUrl, token: "service-secret" }),
  );
  const base = await listen(app.server);
  async function rpc(token: string, method: string, params: unknown) {
    const response = await new Promise<Response>((resolve, reject) => {
      const request = httpRequest(
        `${base}/mcp`,
        {
          method: "POST",
          headers: {
            Host: "mcp.test",
            authorization: `Bearer ${token}`,
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("end", () =>
            resolve(
              new Response(Buffer.concat(chunks), {
                status: incoming.statusCode,
              }),
            ),
          );
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    });
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const result = raw.startsWith("event:")
      ? JSON.parse(raw.split("data: ")[1]!.split("\n")[0]!)
      : JSON.parse(raw);
    return result.result;
  }
  try {
    const listed = await rpc("reader", "tools/list", {});
    assert.equal(
      listed.tools.filter((t: { name: string }) => t.name.startsWith("now_"))
        .length,
      11,
    );
    assert.equal(
      (await rpc("reader", "tools/call", { name: "now_list", arguments: {} }))
        .isError,
      false,
    );
    assert.deepEqual(calls[0], {
      subject: "verified-alice",
      token: "Bearer service-secret",
      body: {},
    });
    const denied = await rpc("reader", "tools/call", {
      name: "now_create",
      arguments: { key: "create-fixture", description: "Test." },
    });
    assert.equal(denied.isError, true);
    assert.equal(calls.length, 1);
    const spoof = await rpc("writer", "tools/call", {
      name: "now_create",
      arguments: {
        key: "create-fixture",
        description: "Test.",
        subject: "bob",
      },
    });
    assert.equal(spoof.isError, true);
    assert.equal(calls.length, 1);
    await rpc("writer", "tools/call", {
      name: "now_create",
      arguments: { key: "create-fixture", description: "Test." },
    });
    assert.equal(calls[1]!.subject, "verified-alice");
    await rpc("writer", "tools/call", {
      name: "now_put_source",
      arguments: {
        key: "large-source-fixture",
        appId: "00000000-0000-4000-8000-000000000001",
        baseRevision: null,
        files: {
          "src/app.ts": "export class App {}",
          "public/app.js": "//" + "x".repeat(100_000),
        },
      },
    });
    assert.equal(
      (calls[2]!.body as { files: Record<string, string> }).files[
        "public/app.js"
      ]!.length,
      100_002,
    );
  } finally {
    await app.close();
    app.server.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => app.server.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});
