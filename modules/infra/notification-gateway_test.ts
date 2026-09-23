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
    destinations: new Map([["leo", "-100123"], ["alerts", "42"]]),
    defaultDestination: "leo",
    webhookSecret: "test-webhook-secret",
    webhookUrl: "https://webhooks.leolab.party/telegram",
    ...overrides,
  };
}

function handler(gatewayConfig = config(), responses: Response[] = []) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const logs: unknown[][] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ input, init });
    return responses.shift() ??
      new Response(
        JSON.stringify({ ok: true, result: { message_id: 123 } }),
        { status: 200 },
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

Deno.test("notification delivery uses the default allowed chat", async () => {
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

Deno.test("notification rejects malformed, oversized, and unknown fields", async () => {
  const test = handler();
  for (
    const body of [
      "not json",
      JSON.stringify({ message: "" }),
      JSON.stringify({ message: "okay", extra: true }),
      JSON.stringify({ message: "x".repeat(3801) }),
    ]
  ) {
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

Deno.test("notification cannot choose an unconfigured destination", async () => {
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

Deno.test("notification can choose a named destination", async () => {
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

Deno.test("Telegram delivery failures are returned to the caller", async () => {
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

Deno.test("a reaction targets an earlier sent message", async () => {
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

Deno.test("a sent message can be edited", async () => {
  const test = handler(config(), [
    new Response(
      JSON.stringify({ ok: true, result: { message_id: 123 } }),
      { status: 200 },
    ),
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

Deno.test("typing status uses the default destination", async () => {
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

Deno.test("startup registers the configured Telegram webhook", async () => {
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

Deno.test("unknown Telegram chats are logged and never forwarded", async () => {
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

Deno.test("allowed Telegram chats are acknowledged without a persistent inbox", async () => {
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

Deno.test("webhook secrets are enforced when configured", async () => {
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

Deno.test("configuration permits discovery mode without an allowed chat", () => {
  const gatewayConfig = loadConfig({
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    TELEGRAM_WEBHOOK_URL: "https://webhooks.leolab.party/telegram",
  });
  assert(gatewayConfig.destinations.size === 0);
  assert(gatewayConfig.defaultDestination === undefined);
});

Deno.test("the first destination is the default", () => {
  const gatewayConfig = loadConfig({
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
    TELEGRAM_WEBHOOK_URL: "https://webhooks.leolab.party/telegram",
    TELEGRAM_DESTINATIONS: "leo:42, alerts:-100123",
  });
  assert(gatewayConfig.defaultDestination === "leo");
  assert(gatewayConfig.destinations.get("alerts") === "-100123");
});
