import { test } from "node:test";
import {
  createHandler,
  type GatewayConfig,
  loadConfig,
  registerTelegramWebhook,
} from "./notification-gateway.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    telegramBotToken: "test-token",
    destinations: new Map([
      ["leo", "-100123"],
      ["alerts", "42"],
    ]),
    defaultDestination: "leo",
    webhookSecret: "test-webhook-secret",
    webhookUrl: "https://webhooks.leolab.party/telegram",
    ...overrides,
  };
}

function handler(gatewayConfig = config(), responses: Response[] = []) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const logs: unknown[][] = [];
  const fakeFetch: typeof fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      responses.shift() ??
        new Response(
          JSON.stringify({ ok: true, result: { message_id: 123 } }),
          { status: 200 },
        ),
    );
  };
  return {
    calls,
    logs,
    fetch: fakeFetch,
    handler: createHandler(gatewayConfig, {
      fetch: fakeFetch,
      log: {
        info: (...values) => logs.push(values),
        warn: (...values) => logs.push(values),
        error: (...values) => logs.push(values),
      },
    }),
  };
}

test("notification delivery uses the default allowed chat", async () => {
  const test = handler();
  const response = await test.handler(
    new Request("http://gateway/v1/notifications", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret",
      },
      body: JSON.stringify({ message: "Paperless import completed" }),
    }),
  );

  assert(response.status === 201);
  assert(
    JSON.stringify(await response.json()) ===
      JSON.stringify({ to: "leo", message_id: 123 }),
  );
  assert(test.calls.length === 1);
  assert(String(test.calls[0].input).includes("bottest-token/sendMessage"));
  assert(
    test.calls[0].init?.body ===
      JSON.stringify({
        chat_id: "-100123",
        text: "Paperless import completed",
      }),
  );
});

test("notification rejects malformed, oversized, and unknown fields", async () => {
  const test = handler();
  for (const body of [
    "not json",
    JSON.stringify({ message: "" }),
    JSON.stringify({ message: "okay", extra: true }),
    JSON.stringify({ message: "x".repeat(3801) }),
  ]) {
    const response = await test.handler(
      new Request("http://gateway/v1/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    assert(response.status === 400);
  }
  assert(test.calls.length === 0);
});

test("notification cannot choose an unconfigured destination", async () => {
  const test = handler();
  const response = await test.handler(
    new Request("http://gateway/v1/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello", to: "unknown" }),
    }),
  );

  assert(response.status === 503);
  assert(test.calls.length === 0);
});

test("notification can choose a named destination", async () => {
  const test = handler();
  const response = await test.handler(
    new Request("http://gateway/v1/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello", to: "alerts" }),
    }),
  );

  assert(response.status === 201);
  assert(
    JSON.stringify(await response.json()) ===
      JSON.stringify({ to: "alerts", message_id: 123 }),
  );
  assert(test.calls.length === 1);
  assert(
    test.calls[0].init?.body ===
      JSON.stringify({ chat_id: "42", text: "hello" }),
  );
});

test("Telegram delivery failures are returned to the caller", async () => {
  const test = handler(config(), [
    new Response(JSON.stringify({ ok: false }), { status: 401 }),
  ]);
  const response = await test.handler(
    new Request("http://gateway/v1/notifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    }),
  );

  assert(response.status === 502);
});

test("a reaction targets an earlier sent message", async () => {
  const test = handler(config(), [
    new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
  ]);
  const response = await test.handler(
    new Request("http://gateway/v1/reactions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "leo", message_id: 123, emoji: "👍" }),
    }),
  );

  assert(response.status === 204);
  assert(String(test.calls[0].input).includes("setMessageReaction"));
  assert(
    test.calls[0].init?.body ===
      JSON.stringify({
        chat_id: "-100123",
        message_id: 123,
        reaction: [{ type: "emoji", emoji: "👍" }],
      }),
  );
});

test("a sent message can be edited", async () => {
  const test = handler(config(), [
    new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
      status: 200,
    }),
  ]);
  const response = await test.handler(
    new Request("http://gateway/v1/messages/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        to: "leo",
        message_id: 123,
        message: "The window is closed now.",
      }),
    }),
  );

  assert(response.status === 204);
  assert(String(test.calls[0].input).includes("editMessageText"));
  assert(
    test.calls[0].init?.body ===
      JSON.stringify({
        chat_id: "-100123",
        message_id: 123,
        text: "The window is closed now.",
      }),
  );
});

test("typing status uses the default destination", async () => {
  const test = handler(config(), [
    new Response(JSON.stringify({ ok: true, result: true }), { status: 200 }),
  ]);
  const response = await test.handler(
    new Request("http://gateway/v1/typing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
  );

  assert(response.status === 204);
  assert(String(test.calls[0].input).includes("sendChatAction"));
  assert(
    test.calls[0].init?.body ===
      JSON.stringify({ chat_id: "-100123", action: "typing" }),
  );
});

test("startup registers the configured Telegram webhook", async () => {
  const test = handler();
  await registerTelegramWebhook(config(), {
    fetch: test.fetch,
    log: console,
  });
  assert(test.calls.length === 1);
  assert(String(test.calls[0].input).includes("bottest-token/setWebhook"));
  assert(
    test.calls[0].init?.body ===
      JSON.stringify({
        url: "https://webhooks.leolab.party/telegram",
        secret_token: "test-webhook-secret",
        allowed_updates: [
          "message",
          "edited_message",
          "channel_post",
          "edited_channel_post",
        ],
      }),
  );
});

test("unknown Telegram chats are logged and never forwarded", async () => {
  const test = handler();
  const response = await test.handler(
    new Request("http://gateway/v1/telegram-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret",
      },
      body: JSON.stringify({
        message: {
          chat: { id: -100999, type: "group", title: "New group" },
          from: { id: 7 },
        },
      }),
    }),
  );

  assert(response.status === 204);
  assert(test.calls.length === 0);
  assert(test.logs.length === 1);
});

test("allowed Telegram chats are acknowledged without a persistent inbox", async () => {
  const test = handler();
  const response = await test.handler(
    new Request("http://gateway/v1/telegram-webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": "test-webhook-secret",
      },
      body: JSON.stringify({
        message: { chat: { id: -100123, type: "group" }, from: { id: 7 } },
      }),
    }),
  );

  assert(response.status === 204);
  assert(test.calls.length === 0);
  assert(test.logs.length === 0);
});

test("webhook secrets are enforced when configured", async () => {
  const test = handler(config({ webhookSecret: "expected" }));
  const response = await test.handler(
    new Request("http://gateway/v1/telegram-webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: { chat: { id: -100123, type: "group" } },
      }),
    }),
  );

  assert(response.status === 401);
  assert(test.calls.length === 0);
});

test("configuration permits discovery mode without an allowed chat", () => {
  const gatewayConfig = loadConfig({
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    TELEGRAM_WEBHOOK_URL: "https://webhooks.leolab.party/telegram",
  });
  assert(gatewayConfig.destinations.size === 0);
  assert(gatewayConfig.defaultDestination === undefined);
});

test("the first destination is the default", () => {
  const gatewayConfig = loadConfig({
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    TELEGRAM_WEBHOOK_URL: "https://webhooks.leolab.party/telegram",
    TELEGRAM_DESTINATIONS: "leo:42, alerts:-100123",
  });
  assert(gatewayConfig.defaultDestination === "leo");
  assert(gatewayConfig.destinations.get("alerts") === "-100123");
});

for (const media of [
  {
    kind: "image",
    path: "images",
    method: "sendPhoto",
    field: "photo",
    mime: "image/png",
    name: "test.png",
    maximumBytes: 10 * 1024 * 1024,
  },
  {
    kind: "voice",
    path: "voice",
    method: "sendVoice",
    field: "voice",
    mime: "audio/ogg",
    name: "test.ogg",
    maximumBytes: 50 * 1024 * 1024,
  },
]) {
  const url = `http://gateway/v1/${media.path}`;

  test(`${media.kind} supports HTTPS URLs and Telegram file IDs`, async () => {
    for (const source of ["https://example.com/media", "AgAC_file-id123"]) {
      const test = handler();
      const response = await test.handler(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            [media.kind]: source,
            caption: "<plain caption>",
            to: "alerts",
          }),
        }),
      );
      assert(response.status === 201);
      assert(
        JSON.stringify(await response.json()) ===
          JSON.stringify({ to: "alerts", message_id: 123 }),
      );
      assert(String(test.calls[0].input).endsWith(`/${media.method}`));
      assert(
        test.calls[0].init?.body ===
          JSON.stringify({
            chat_id: "42",
            [media.field]: source,
            caption: "<plain caption>",
          }),
      );
    }
  });

  test(`${media.kind} uploads preserve file bytes and use the default destination`, async () => {
    const test = handler();
    const bytes = new Uint8Array([0, 1, 255, 42]);
    const form = new FormData();
    form.set(media.kind, new File([bytes], media.name, { type: media.mime }));
    form.set("caption", "A test notification");
    const response = await test.handler(
      new Request(url, { method: "POST", body: form }),
    );
    assert(response.status === 201);
    assert(
      JSON.stringify(await response.json()) ===
        JSON.stringify({ to: "leo", message_id: 123 }),
    );
    assert(String(test.calls[0].input).endsWith(`/${media.method}`));
    const body = test.calls[0].init?.body;
    assert(body instanceof FormData);
    assert(
      test.calls[0].init?.headers === undefined,
      "fetch must generate the multipart boundary",
    );
    assert(body.get("chat_id") === "-100123");
    assert(body.get("caption") === "A test notification");
    assert(!body.has("parse_mode"));
    const file = body.get(media.field);
    assert(file instanceof File);
    assert(file.name === media.name && file.type === media.mime);
    assert(String(new Uint8Array(await file.arrayBuffer())) === String(bytes));
  });

  test(`${media.kind} rejects invalid JSON media and metadata without contacting Telegram`, async () => {
    const test = handler();
    for (const value of [
      null,
      {},
      { [media.kind]: "" },
      { [media.kind]: 42 },
      { [media.kind]: "http://example.com/media" },
      { [media.kind]: "file:///etc/passwd" },
      { [media.kind]: "attach://upload" },
      { [media.kind]: "https://user:password@example.com/media" },
      { [media.kind]: "x".repeat(2049) },
      { [media.kind]: "file_id", caption: "x".repeat(1025) },
      { [media.kind]: "file_id", caption: false },
      { [media.kind]: "file_id", to: 42 },
      { [media.kind]: "file_id", to: "bad destination" },
      { [media.kind]: "file_id", chat_id: "unapproved" },
      { [media.kind]: "file_id", parse_mode: "HTML" },
    ]) {
      const response = await test.handler(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(value),
        }),
      );
      assert(response.status === 400, JSON.stringify(value));
    }
    assert(test.calls.length === 0);
  });

  test(`${media.kind} rejects duplicate, empty, unsupported and unexpected multipart fields`, async () => {
    const test = handler();
    for (const variant of [
      "duplicate",
      "empty",
      "mime",
      "unknown",
      "file-caption",
      "file-to",
      "missing",
      "long-caption",
    ]) {
      const form = new FormData();
      const file = new File(
        [variant === "empty" ? "" : "media bytes"],
        media.name,
        { type: variant === "mime" ? "text/plain" : media.mime },
      );
      if (variant !== "missing") form.set(media.kind, file);
      if (variant === "duplicate") form.append(media.kind, file);
      if (variant === "unknown") form.set("extra", "unexpected");
      if (variant === "file-caption") form.set("caption", file);
      if (variant === "file-to") form.set("to", file);
      if (variant === "long-caption") form.set("caption", "x".repeat(1025));
      const response = await test.handler(
        new Request(url, { method: "POST", body: form }),
      );
      assert(response.status === 400, variant);
    }
    assert(test.calls.length === 0);
  });

  test(`${media.kind} enforces both file and streamed body size limits`, async () => {
    const test = handler();
    const form = new FormData();
    form.set(
      media.kind,
      new File([new Uint8Array(media.maximumBytes + 1)], media.name, {
        type: media.mime,
      }),
    );
    assert(
      (await test.handler(new Request(url, { method: "POST", body: form })))
        .status === 400,
    );
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(media.maximumBytes + 64 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    assert(
      (
        await test.handler(
          new Request(url, {
            method: "POST",
            headers: { "content-type": "multipart/form-data; boundary=test" },
            body: stream,
            ...{ duplex: "half" as const },
          }),
        )
      ).status === 400,
    );
    assert(cancelled);
    assert(test.calls.length === 0);
  });

  test(`${media.kind} rejects unconfigured destinations and reports Telegram failures`, async () => {
    const test = handler();
    const form = new FormData();
    form.set(media.kind, new File(["media"], media.name, { type: media.mime }));
    form.set("to", "unknown");
    assert(
      (await test.handler(new Request(url, { method: "POST", body: form })))
        .status === 503,
    );
    assert(
      (
        await test.handler(
          new Request(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ [media.kind]: "file_id", to: "unknown" }),
          }),
        )
      ).status === 503,
    );
    assert(test.calls.length === 0);
    for (const upstream of [
      new Response(JSON.stringify({ ok: false }), { status: 400 }),
      new Response(JSON.stringify({ ok: false }), { status: 200 }),
      new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
      }),
      new Response("invalid JSON", { status: 200 }),
    ]) {
      const failing = handler(config(), [upstream]);
      assert(
        (
          await failing.handler(
            new Request(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ [media.kind]: "file_id" }),
            }),
          )
        ).status === 502,
      );
    }
  });

  test(`${media.kind} rejects malformed uploads, wrong methods and content types`, async () => {
    const test = handler();
    for (const request of [
      new Request(url),
      new Request(url, { method: "PUT", body: "media" }),
      new Request(url, { method: "POST", body: "media" }),
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "bad JSON",
      }),
      new Request(url, {
        method: "POST",
        headers: { "content-type": "multipart/form-data" },
        body: "bad multipart",
      }),
      new Request(url, {
        method: "POST",
        headers: {
          "content-type": "multipart/form-data; boundary=test",
          "content-length": String(media.maximumBytes + 64 * 1024 + 1),
        },
        body: "too large",
      }),
    ]) {
      assert((await test.handler(request)).status === 400);
    }
    assert(test.calls.length === 0);
  });
}
