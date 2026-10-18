import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHandler, type GatewayConfig } from "./ai-gateway.ts";
import { createWebServer } from "../runtime/http.ts";

const config: GatewayConfig = {
  apiKey: "upstream-test-key",
  chatModels: ["glm-5.3", "deepseek-v4.1-flash", "kimi-k3", "deepseek-v4-pro"],
  defaultChatModel: "glm-5.3",
  systemoneModels: ["jev-1.13"],
  defaultSystemoneModel: "jev-1.13",
  maxBodyBytes: 1024,
  maxConcurrent: 1,
  timeoutMs: 1000,
};
const request = (
  payload: unknown = {},
  path = "/v1/chat/completions",
  signal?: AbortSignal,
) =>
  new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer attacker",
      cookie: "private",
      "x-api-key": "attacker",
    },
    body: JSON.stringify(payload),
    signal,
  });
const quiet = { info() {} };

test("local endpoints and model validation never call upstream", async () => {
  const handler = createHandler(config, {
    fetch: async () => {
      throw new Error("unexpected upstream");
    },
    log: quiet,
  });
  assert.equal(
    (await handler(new Request("http://localhost/healthz"))).status,
    204,
  );
  const models = await (
    await handler(new Request("http://localhost/v1/models"))
  ).json();
  assert.deepEqual(
    models.data.map((m: { id: string }) => m.id),
    [...config.chatModels, "jev-1.13"],
  );
  for (const model of ["other", "jev-1.13", null, 1])
    assert.equal((await handler(request({ model }))).status, 400);
  assert.equal(
    (await handler(request({ model: "glm-5.3" }, "/v1/systemone"))).status,
    400,
  );
  assert.equal(
    (await handler(request({}, "/v1/chat/completions?model=other"))).status,
    400,
  );
  assert.equal((await handler(request("invalid"))).status, 400);
  assert.equal(
    (await handler(request({ data: "x".repeat(1024) }))).status,
    413,
  );
});

test("both protocol defaults, allowlist, body compatibility and isolated headers", async () => {
  const records: Request[] = [];
  const handler = createHandler(config, {
    log: quiet,
    fetch: async (input, init) => {
      const req = new Request(input, init);
      records.push(req);
      return new Response('{"ok":true}', {
        headers: {
          "content-type": "application/json",
          "set-cookie": "secret",
          "x-request-id": "trace",
        },
      });
    },
  });
  for (const path of ["/v1/chat/completions", "/v1/systemone"]) {
    const response = await handler(
      request(
        {
          model: "default",
          messages: [{ role: "user", content: "secret prompt" }],
          tools: [{ type: "function" }],
          stream: true,
        },
        path,
      ),
    );
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("x-request-id"), "trace");
    await response.text();
    const upstream = records.at(-1)!;
    assert.equal(
      upstream.url,
      `https://opencode.ai/inference/${path === "/v1/systemone" ? "systemone/v1/systemone" : "openai/v1/chat/completions"}`,
    );
    assert.equal(
      upstream.headers.get("authorization"),
      "Bearer upstream-test-key",
    );
    assert.equal(upstream.headers.get("cookie"), null);
    assert.equal(upstream.headers.get("x-api-key"), null);
    const payload = await upstream.json();
    assert.equal(
      payload.model,
      path === "/v1/systemone" ? "jev-1.13" : "glm-5.3",
    );
    assert.equal(payload.stream, true);
    assert.equal(payload.tools.length, 1);
  }
  for (const model of config.chatModels)
    await (await handler(request({ model }))).text();
});

test("stream chunks arrive before completion and capacity lasts until stream completion", async () => {
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const logs: string[] = [];
  const handler = createHandler(config, {
    log: { info: (value) => logs.push(value) },
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(c) {
            output = c;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const response = await handler(request());
  const reader = response.body!.getReader();
  output.enqueue(new TextEncoder().encode("data: first\n\n"));
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    "data: first\n\n",
  );
  assert.equal((await handler(request())).status, 429);
  output.close();
  assert.equal((await reader.read()).done, true);
  assert.equal(logs.length, 1);
  assert.ok(!logs[0].includes(config.apiKey));
});

test("upstream errors pass through once, redirects and transport errors do not retry", async () => {
  for (const upstreamStatus of [429, 503, 307]) {
    let calls = 0;
    const handler = createHandler(config, {
      log: quiet,
      fetch: async () => {
        calls++;
        return new Response("upstream failure", {
          status: upstreamStatus,
          headers: { "retry-after": "2", location: "https://evil.example" },
        });
      },
    });
    const response = await handler(request());
    assert.equal(
      response.status,
      upstreamStatus === 307 ? 502 : upstreamStatus,
    );
    await response.text();
    assert.equal(calls, 1);
  }
});

test("timeout aborts upstream and releases concurrency", async () => {
  let calls = 0;
  const handler = createHandler(
    { ...config, timeoutMs: 20 },
    {
      log: quiet,
      fetch: async (_input, init) => {
        calls++;
        await new Promise((_resolve, reject) =>
          init!.signal!.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          ),
        );
        return new Response();
      },
    },
  );
  assert.equal((await handler(request())).status, 504);
  assert.equal((await handler(request())).status, 504);
  assert.equal(calls, 2);
});

test("real client disconnect aborts the in-flight upstream stream", async () => {
  let upstreamSignal!: AbortSignal;
  let cancelled = false;
  const handler = createHandler(config, {
    log: quiet,
    fetch: async (_input, init) => {
      upstreamSignal = init!.signal!;
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: hello\n\n"));
            upstreamSignal.addEventListener(
              "abort",
              () => {
                cancelled = true;
                c.error(new Error("aborted"));
              },
              { once: true },
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  });
  const server = createWebServer(handler, { error() {} });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    for (let i = 0; i < 50 && !upstreamSignal.aborted; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(upstreamSignal.aborted, true);
  } finally {
    server.closeAllConnections();
    server.close();
  }
  assert.equal(cancelled, true);
});

test("chunked body limit and slow request timeout release the reader and capacity", async () => {
  const handler = createHandler(
    { ...config, timeoutMs: 20 },
    {
      log: quiet,
      fetch: async () => {
        throw new Error("unexpected upstream");
      },
    },
  );
  let cancelled = false;
  const oversized = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...{ duplex: "half" as const },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(1025));
      },
      cancel() {
        cancelled = true;
      },
    }),
  });
  assert.equal((await handler(oversized)).status, 413);
  assert.equal(cancelled, true);
  const slow = new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...{ duplex: "half" as const },
    body: new ReadableStream(),
  });
  assert.equal((await handler(slow)).status, 504);
  assert.equal((await handler(request({ model: "invalid" }))).status, 400);
});

test("a failing upstream stream cancellation still releases capacity", async () => {
  const handler = createHandler(config, {
    log: quiet,
    fetch: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error("transport cancellation failed");
          },
        }),
      ),
  });
  const response = await handler(request());
  await assert.rejects(response.body!.cancel());
  assert.equal((await handler(request({ model: "invalid" }))).status, 400);
});
