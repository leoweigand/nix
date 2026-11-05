import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAIProvider } from "./openai-oauth.ts";

async function authFile() {
  const dir = await mkdtemp(join(tmpdir(), "gateway-oauth-test-"));
  const path = join(dir, "auth.json");
  await writeFile(
    path,
    JSON.stringify({
      tokens: { access_token: "test-access", account_id: "test-account" },
      last_refresh: new Date().toISOString(),
    }),
  );
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
const catalog = () =>
  Response.json({
    models: ["gpt-test", "gpt-other", "gpt-image-2"].map((slug) => ({
      slug,
      visibility: "list",
      supported_in_api: true,
    })),
  });
const request = (signal?: AbortSignal, stream = false) =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-test",
      messages: [{ role: "user", content: "hello" }],
      reasoning_effort: "high",
      stream,
    }),
    signal,
  });

test("real OAuth adapter discovers models and supports an optional allow-list", async () => {
  const auth = await authFile();
  try {
    for (const allowed of [null, ["gpt-test"]]) {
      let calls = 0;
      const provider = createOpenAIProvider(
        auth.path,
        allowed,
        async (input, init) => {
          const upstream = new Request(input, init);
          if (new URL(upstream.url).hostname === "registry.npmjs.org")
            return Response.json({ version: "0.166.0" });
          assert.equal(
            upstream.headers.get("authorization"),
            "Bearer test-access",
          );
          assert.equal(
            upstream.url,
            "https://chatgpt.com/backend-api/codex/models?client_version=0.166.0",
          );
          calls++;
          return catalog();
        },
      );
      assert.deepEqual(
        await provider.models(AbortSignal.timeout(1000)),
        allowed ?? ["gpt-test", "gpt-other"],
      );
      await provider.models(AbortSignal.timeout(1000));
      assert.equal(calls, 1);
    }
  } finally {
    await auth.cleanup();
  }
});

test("real OAuth chat adapter passes effort and makes one inference attempt on failure", async () => {
  const auth = await authFile();
  try {
    let calls = 0;
    const provider = createOpenAIProvider(
      auth.path,
      null,
      async (input, init) => {
        const upstream = new Request(input, init);
        if (new URL(upstream.url).hostname === "registry.npmjs.org")
          return Response.json({ version: "0.166.0" });
        if (upstream.method === "GET") return catalog();
        calls++;
        assert.equal(
          upstream.url,
          "https://chatgpt.com/backend-api/codex/responses",
        );
        assert.equal((await upstream.json()).reasoning.effort, "high");
        return Response.json(
          {
            error: {
              message: "rate limited",
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
            },
          },
          { status: 429 },
        );
      },
    );
    const response = await provider.handle(request());
    assert.equal(response.status, 429);
    assert.equal(calls, 1);
  } finally {
    await auth.cleanup();
  }
});

test("real OAuth adapter cancels buffered and streaming inference", async () => {
  const auth = await authFile();
  try {
    for (const stream of [false, true]) {
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let cancelled = false;
      const provider = createOpenAIProvider(
        auth.path,
        null,
        async (input, init) => {
          const upstream = new Request(input, init);
          if (new URL(upstream.url).hostname === "registry.npmjs.org")
            return Response.json({ version: "0.166.0" });
          if (upstream.method === "GET") return catalog();
          started();
          await new Promise<void>((_resolve, reject) => {
            upstream.signal.addEventListener(
              "abort",
              () => {
                cancelled = true;
                reject(new Error("cancelled"));
              },
              { once: true },
            );
          });
          throw new Error("unreachable");
        },
      );
      const controller = new AbortController();
      const pending = provider.handle(request(controller.signal, stream));
      await ready;
      controller.abort();
      const response = await pending;
      await response.text().catch(() => {});
      assert.equal(cancelled, true);
    }
  } finally {
    await auth.cleanup();
  }
});
