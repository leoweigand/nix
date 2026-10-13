import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { createWebServer } from "./http.ts";
import {
  createHandler,
  type GatewayConfig,
} from "../infra/notification-gateway.ts";

const config: GatewayConfig = {
  telegramBotToken: "fake",
  destinations: new Map([["leo", "42"]]),
  defaultDestination: "leo",
  webhookSecret: "secret",
  webhookUrl: "https://example.org/telegram",
};

test("HTTP adapter preserves JSON and multipart file bytes on real sockets", async (t) => {
  const calls: RequestInit[] = [];
  const handler = createHandler(config, {
    fetch: async (_url, init) => {
      calls.push(init!);
      return Response.json({ ok: true, result: { message_id: 123 } });
    },
    log: console,
  });
  const server = createWebServer(handler).listen(0, "127.0.0.1");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  const response = await fetch(`${url}/v1/notifications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hello" }),
  });
  assert.equal(response.status, 201);
  const form = new FormData();
  const bytes = new Uint8Array([0, 255, 1, 128]);
  form.append("image", new Blob([bytes], { type: "image/png" }), "image.png");
  const upload = await fetch(`${url}/v1/images`, {
    method: "POST",
    body: form,
  });
  assert.equal(upload.status, 201);
  const sent = (calls[1].body as FormData).get("photo") as File;
  assert.deepEqual(new Uint8Array(await sent.arrayBuffer()), bytes);
});

test("HTTP adapter returns the existing 400 for oversized chunked requests without destroying the response", async (t) => {
  const server = createWebServer(createHandler(config)).listen(0, "127.0.0.1");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const result = await new Promise<number>((resolve, reject) => {
    const incoming = request(
      {
        hostname: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/notifications",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    incoming.on("error", reject);
    incoming.write("x".repeat(9000));
    incoming.end();
  });
  assert.equal(result, 400);
});
