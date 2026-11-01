import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.ts";
import { MediaService } from "./media.ts";
import { DocumentService, DocumentAccess } from "./documents.ts";

function send(url: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: init.method, headers: init.headers as Record<string, string> },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode,
              headers: res.headers as Record<string, string>,
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body as string);
  });
}
test("MCP document discovery, group authorization and binary upload contract work over HTTP", async () => {
  const directory = mkdtempSync(join(tmpdir(), "documents-http-"));
  let backendCalls = 0;
  let member = true;
  const issuer = "https://auth.example.test";
  const service = new DocumentService(
    {
      url: "http://127.0.0.1:28981",
      publicUrl: "https://documents.example.test",
      token: "test",
      stateDir: directory,
    },
    async () => {
      backendCalls++;
      return Response.json({
        count: 1,
        results: [{ id: 1, title: "Invoice", content: "Washing machine" }],
      });
    },
  );
  const access = new DocumentAccess(issuer, "admins", async () =>
    Response.json({ sub: "leo", groups: member ? ["admins"] : [] }),
  );
  const app = createApp(
    { issuer, resource: "https://mcp.example.test/mcp" },
    async (token) => ({
      token,
      clientId: "test",
      scopes:
        token === "read-only"
          ? ["openid", "groups", "documents:read"]
          : ["openid", "groups", "documents:read", "documents:ingest"],
      extra: { subject: "leo" },
    }),
    new MediaService({
      sonarr: {
        url: "http://127.0.0.1:8989",
        apiKey: "fixture",
        rootFolder: "/tv",
      },
      radarr: {
        url: "http://127.0.0.1:7878",
        apiKey: "fixture",
        rootFolder: "/movies",
      },
    }),
    undefined,
    undefined,
    service,
    access,
  );
  await new Promise<void>((resolve) =>
    app.server.listen(0, "127.0.0.1", resolve),
  );
  const address = app.server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = {
    host: "mcp.example.test",
    authorization: "Bearer admin",
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-11-25",
  };
  let counter = 0;
  const call = async (method: string, params: unknown = {}) => {
    const r = await send(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: ++counter, method, params }),
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    return JSON.parse(
      text.startsWith("event:")
        ? text
            .split("\n")
            .find((line) => line.startsWith("data:"))!
            .slice(5)
        : text,
    ) as any;
  };
  try {
    await call("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    const list = await call("tools/list");
    for (const name of [
      "search_documents",
      "get_document",
      "ingest_document",
      "get_ingestion_status",
    ])
      assert(
        list.result.tools.some((t: any) => t.name === name && t.outputSchema),
      );
    const result = await call("tools/call", {
      name: "search_documents",
      arguments: { query: "washing machine" },
    });
    assert.equal(result.result.structuredContent.documents[0].documentId, 1);
    assert.deepEqual(
      JSON.parse(result.result.content[0].text),
      result.result.structuredContent,
    );
    const before = backendCalls;
    member = false;
    const denied = await call("tools/call", {
      name: "search_documents",
      arguments: { query: "invoice" },
    });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /documents_forbidden/);
    assert.equal(backendCalls, before);
    let r = await send(`${base}/attachments`, {
      method: "POST",
      headers: { ...headers, "x-document-filename": "invoice.pdf" },
      body: "%PDF-1.4",
    });
    assert.equal(r.status, 403);
    member = true;
    // More than two sequential uploads verifies upload concurrency slots are released.
    for (let i = 0; i < 3; i++) {
      r = await send(`${base}/attachments`, {
        method: "POST",
        headers: { ...headers, "x-document-filename": "invoice.pdf" },
        body: "%PDF-1.4",
      });
      assert.equal(r.status, 201);
      assert.equal(typeof ((await r.json()) as any).attachmentId, "string");
    }
    r = await send(`${base}/attachments`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer read-only" },
      body: "%PDF-1.4",
    });
    assert.equal(r.status, 403);
    const noScope = await send(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer read-only" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: {
          name: "ingest_document",
          arguments: { attachmentId: "7be0ab20-f426-4d86-bff9-2784ce0e879b" },
        },
      }),
    });
    assert.equal(noScope.status, 403);
  } finally {
    await app.close();
    app.server.closeAllConnections();
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
