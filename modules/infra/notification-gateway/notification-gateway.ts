import { restrictedFetch } from "../../runtime/network.ts";
import { createWebServer } from "../../runtime/http.ts";

const automationFetch = restrictedFetch(["https://api.telegram.org"]);

const MAX_MESSAGE_LENGTH = 3800;
const MAX_NOTIFICATION_BODY_BYTES = 8 * 1024;
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;
const MAX_CAPTION_LENGTH = 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MEDIA = {
  image: {
    method: "sendPhoto",
    telegramField: "photo",
    maximumBytes: 10 * 1024 * 1024,
    mimeTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  voice: {
    method: "sendVoice",
    telegramField: "voice",
    maximumBytes: 50 * 1024 * 1024,
    mimeTypes: ["audio/ogg", "audio/mpeg", "audio/mp4"],
  },
};
type MediaKind = keyof typeof MEDIA;

export interface GatewayConfig {
  telegramBotToken: string;
  destinations: Map<string, string>;
  defaultDestination?: string;
  webhookSecret: string;
  webhookUrl: string;
}

interface GatewayDependencies {
  fetch: typeof fetch;
  log: Pick<Console, "info" | "warn" | "error">;
}

const defaultDependencies: GatewayDependencies = {
  fetch: automationFetch,
  log: console,
};

function requiredEnvironment(
  name: string,
  environment: Record<string, string | undefined>,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

function runtimeEnvironment(): Record<string, string | undefined> {
  return {
    TELEGRAM_BOT_TOKEN: process.env["TELEGRAM_BOT_TOKEN"],
    TELEGRAM_DESTINATIONS: process.env["TELEGRAM_DESTINATIONS"],
    TELEGRAM_WEBHOOK_SECRET: process.env["TELEGRAM_WEBHOOK_SECRET"],
    TELEGRAM_WEBHOOK_URL: process.env["TELEGRAM_WEBHOOK_URL"],
  };
}

export function loadConfig(
  environment: Record<string, string | undefined> = runtimeEnvironment(),
): GatewayConfig {
  const destinations = new Map<string, string>();
  for (const entry of (environment.TELEGRAM_DESTINATIONS ?? "").split(",")) {
    if (!entry.trim()) {
      continue;
    }
    const separator = entry.indexOf(":");
    const name = entry.slice(0, separator).trim();
    const chatId = entry.slice(separator + 1).trim();
    if (separator < 1 || !/^[a-z][a-z0-9_-]*$/.test(name) || !chatId) {
      throw new Error("TELEGRAM_DESTINATIONS entries must use name:chat_id");
    }
    if (destinations.has(name) || [...destinations.values()].includes(chatId)) {
      throw new Error(
        "TELEGRAM_DESTINATIONS names and chat IDs must be unique",
      );
    }
    destinations.set(name, chatId);
  }
  const webhookUrl = requiredEnvironment("TELEGRAM_WEBHOOK_URL", environment);
  if (new URL(webhookUrl).protocol !== "https:") {
    throw new Error("TELEGRAM_WEBHOOK_URL must use HTTPS");
  }

  return {
    telegramBotToken: requiredEnvironment("TELEGRAM_BOT_TOKEN", environment),
    destinations,
    defaultDestination: destinations.keys().next().value,
    webhookSecret: requiredEnvironment("TELEGRAM_WEBHOOK_SECRET", environment),
    webhookUrl,
  };
}

async function readBytes(
  request: Request,
  maximumBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > maximumBytes) {
    throw new RangeError("request body is too large");
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new RangeError("request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readBody(
  request: Request,
  maximumBytes: number,
): Promise<string> {
  return new TextDecoder().decode(await readBytes(request, maximumBytes));
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new TypeError("request body must be valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notificationFrom(value: unknown): {
  message: string;
  destination?: string;
} {
  if (!isRecord(value)) {
    throw new TypeError("request body must be a JSON object");
  }

  const keys = Object.keys(value);
  if (keys.some((key) => key !== "message" && key !== "to")) {
    throw new TypeError("request body has unknown fields");
  }
  if (typeof value.message !== "string" || !value.message.trim()) {
    throw new TypeError("message must be a non-empty string");
  }
  if (value.message.length > MAX_MESSAGE_LENGTH) {
    throw new RangeError(
      `message must be at most ${MAX_MESSAGE_LENGTH} characters`,
    );
  }
  if (
    value.to !== undefined &&
    (typeof value.to !== "string" || !/^[a-z][a-z0-9_-]*$/.test(value.to))
  ) {
    throw new TypeError("to must be a valid destination name when provided");
  }

  return { message: value.message, destination: value.to };
}

function messageEditFrom(value: unknown): {
  message: string;
  messageId: number;
  destination?: string;
} {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) => !["message", "message_id", "to"].includes(key),
    )
  ) {
    throw new TypeError("request body has unknown fields");
  }
  const notification = notificationFrom({
    message: value.message,
    to: value.to,
  });
  if (
    typeof value.message_id !== "number" ||
    !Number.isSafeInteger(value.message_id) ||
    value.message_id < 1
  ) {
    throw new TypeError("message_id must be a positive integer");
  }
  return { ...notification, messageId: value.message_id };
}

async function sendTelegramMessage(
  config: GatewayConfig,
  dependencies: GatewayDependencies,
  chatId: string,
  message: string,
): Promise<number | undefined> {
  const result = await callTelegram(config, dependencies, "sendMessage", {
    chat_id: chatId,
    text: message,
  });
  if (!isRecord(result) || typeof result.message_id !== "number") {
    return undefined;
  }
  return result.message_id;
}

async function callTelegram(
  config: GatewayConfig,
  dependencies: GatewayDependencies,
  method: string,
  body: Record<string, unknown> | FormData,
): Promise<unknown | undefined> {
  try {
    const response = await dependencies.fetch(
      `https://api.telegram.org/bot${config.telegramBotToken}/${method}`,
      {
        method: "POST",
        headers:
          body instanceof FormData
            ? undefined
            : { "content-type": "application/json" },
        body: body instanceof FormData ? body : JSON.stringify(body),
      },
    );
    if (!response.ok) {
      dependencies.log.warn("Telegram API request failed", {
        method,
        status: response.status,
      });
      return undefined;
    }

    const result: unknown = await response.json();
    if (!isRecord(result) || result.ok !== true) {
      dependencies.log.warn("Telegram API request was rejected", { method });
      return undefined;
    }
    return result.result;
  } catch {
    dependencies.log.warn("Telegram API request failed", { method });
    return undefined;
  }
}

function destinationFor(
  config: GatewayConfig,
  requestedDestination: string | undefined,
): { name: string; chatId: string } | undefined {
  const name = requestedDestination ?? config.defaultDestination;
  const chatId = name && config.destinations.get(name);
  return name && chatId ? { name, chatId } : undefined;
}

export async function registerTelegramWebhook(
  config: GatewayConfig,
  dependencies = defaultDependencies,
): Promise<void> {
  try {
    const response = await dependencies.fetch(
      `https://api.telegram.org/bot${config.telegramBotToken}/setWebhook`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: config.webhookUrl,
          secret_token: config.webhookSecret,
          allowed_updates: [
            "message",
            "edited_message",
            "channel_post",
            "edited_channel_post",
          ],
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `Telegram webhook registration failed with status ${response.status}`,
      );
    }
    const result: unknown = await response.json();
    if (!isRecord(result) || result.ok !== true) {
      throw new Error("Telegram webhook registration was rejected");
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Telegram webhook registration")
    ) {
      throw error;
    }
    throw new Error("Telegram webhook registration failed");
  }
}

function telegramChat(update: unknown): Record<string, unknown> | undefined {
  if (!isRecord(update)) {
    return undefined;
  }
  for (const key of [
    "message",
    "edited_message",
    "channel_post",
    "edited_channel_post",
  ]) {
    const message = update[key];
    if (isRecord(message) && isRecord(message.chat)) {
      return message;
    }
  }
  return undefined;
}

async function handleNotification(
  request: Request,
  config: GatewayConfig,
  dependencies: GatewayDependencies,
): Promise<Response> {
  if (
    request.method !== "POST" ||
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return new Response(null, { status: 400 });
  }

  try {
    const notification = notificationFrom(
      parseJson(await readBody(request, MAX_NOTIFICATION_BODY_BYTES)),
    );
    const destination = destinationFor(config, notification.destination);
    if (!destination) {
      dependencies.log.warn(
        "Notification request used an unconfigured Telegram destination",
        { destination: notification.destination ?? config.defaultDestination },
      );
      return new Response(null, { status: 503 });
    }

    const messageId = await sendTelegramMessage(
      config,
      dependencies,
      destination.chatId,
      notification.message,
    );
    if (messageId === undefined) {
      return new Response(null, { status: 502 });
    }
    return Response.json(
      { to: destination.name, message_id: messageId },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof RangeError) {
      return new Response(null, { status: 400 });
    }
    return new Response(null, { status: 400 });
  }
}

async function mediaFrom(
  request: Request,
  kind: MediaKind,
): Promise<{ media: string | File; destination?: string; caption?: string }> {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaConfig = MEDIA[kind];
  let value: unknown;
  if (contentType.toLowerCase().startsWith("application/json")) {
    value = parseJson(await readBody(request, MAX_NOTIFICATION_BODY_BYTES));
  } else if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    // Bound the raw body before formData() buffers and parses uploaded files.
    const bytes = await readBytes(
      request,
      mediaConfig.maximumBytes + MAX_MULTIPART_OVERHEAD_BYTES,
    );
    const form = await new Response(bytes, {
      headers: { "content-type": contentType },
    }).formData();
    const fields: Record<string, FormDataEntryValue> = Object.create(null);
    for (const [key, entry] of form) {
      if (Object.hasOwn(fields, key)) {
        throw new TypeError("duplicate form fields are not allowed");
      }
      fields[key] = entry;
    }
    value = fields;
  } else {
    throw new TypeError("request must be JSON or multipart/form-data");
  }

  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => ![kind, "to", "caption"].includes(key))
  ) {
    throw new TypeError("request body has unknown fields");
  }
  if (
    value.to !== undefined &&
    (typeof value.to !== "string" || !/^[a-z][a-z0-9_-]*$/.test(value.to))
  ) {
    throw new TypeError("to must be a valid destination name when provided");
  }
  if (
    value.caption !== undefined &&
    (typeof value.caption !== "string" ||
      value.caption.length > MAX_CAPTION_LENGTH)
  ) {
    throw new TypeError(
      `caption must be at most ${MAX_CAPTION_LENGTH} characters`,
    );
  }
  const media = value[kind];
  if (media instanceof File) {
    if (media.size === 0 || media.size > mediaConfig.maximumBytes) {
      throw new RangeError("media file is empty or too large");
    }
    if (!mediaConfig.mimeTypes.includes(media.type)) {
      throw new TypeError("unsupported media content type");
    }
  } else if (typeof media === "string" && media.length <= 2048) {
    if (!/^[A-Za-z0-9_-]+$/.test(media)) {
      const url = new URL(media);
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new TypeError(
          "media must be a public HTTPS URL or Telegram file ID",
        );
      }
    }
  } else {
    throw new TypeError("media must be a file, HTTPS URL or Telegram file ID");
  }
  return { media, destination: value.to, caption: value.caption };
}

async function handleMedia(
  request: Request,
  config: GatewayConfig,
  dependencies: GatewayDependencies,
  kind: MediaKind,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 400 });
  }
  try {
    const notification = await mediaFrom(request, kind);
    const destination = destinationFor(config, notification.destination);
    if (!destination) {
      return new Response(null, { status: 503 });
    }
    const mediaConfig = MEDIA[kind];
    let body: FormData | Record<string, unknown>;
    if (notification.media instanceof File) {
      body = new FormData();
      body.set("chat_id", destination.chatId);
      body.set(mediaConfig.telegramField, notification.media);
      if (notification.caption !== undefined) {
        body.set("caption", notification.caption);
      }
    } else {
      body = {
        chat_id: destination.chatId,
        [mediaConfig.telegramField]: notification.media,
        ...(notification.caption !== undefined
          ? { caption: notification.caption }
          : {}),
      };
    }
    const result = await callTelegram(
      config,
      dependencies,
      mediaConfig.method,
      body,
    );
    if (!isRecord(result) || typeof result.message_id !== "number") {
      return new Response(null, { status: 502 });
    }
    return Response.json(
      { to: destination.name, message_id: result.message_id },
      { status: 201 },
    );
  } catch {
    return new Response(null, { status: 400 });
  }
}

async function handleReaction(
  request: Request,
  config: GatewayConfig,
  dependencies: GatewayDependencies,
): Promise<Response> {
  if (
    request.method !== "POST" ||
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return new Response(null, { status: 400 });
  }

  try {
    const value = parseJson(
      await readBody(request, MAX_NOTIFICATION_BODY_BYTES),
    );
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) => !["to", "message_id", "emoji"].includes(key),
      )
    ) {
      return new Response(null, { status: 400 });
    }
    const destination =
      value.to === undefined
        ? undefined
        : typeof value.to === "string" && /^[a-z][a-z0-9_-]*$/.test(value.to)
          ? value.to
          : undefined;
    const messageId = value.message_id;
    if (
      (value.to !== undefined && !destination) ||
      typeof messageId !== "number" ||
      !Number.isSafeInteger(messageId) ||
      messageId < 1 ||
      typeof value.emoji !== "string" ||
      !value.emoji.trim() ||
      Array.from(value.emoji).length > 32
    ) {
      return new Response(null, { status: 400 });
    }
    const target = destinationFor(config, destination);
    if (!target) {
      return new Response(null, { status: 503 });
    }
    const result = await callTelegram(
      config,
      dependencies,
      "setMessageReaction",
      {
        chat_id: target.chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji: value.emoji }],
      },
    );
    return new Response(null, { status: result === true ? 204 : 502 });
  } catch {
    return new Response(null, { status: 400 });
  }
}

async function handleMessageEdit(
  request: Request,
  config: GatewayConfig,
  dependencies: GatewayDependencies,
): Promise<Response> {
  if (
    request.method !== "POST" ||
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return new Response(null, { status: 400 });
  }

  try {
    const edit = messageEditFrom(
      parseJson(await readBody(request, MAX_NOTIFICATION_BODY_BYTES)),
    );
    const destination = destinationFor(config, edit.destination);
    if (!destination) {
      return new Response(null, { status: 503 });
    }
    const result = await callTelegram(config, dependencies, "editMessageText", {
      chat_id: destination.chatId,
      message_id: edit.messageId,
      text: edit.message,
    });
    return new Response(null, { status: result === undefined ? 502 : 204 });
  } catch {
    return new Response(null, { status: 400 });
  }
}

async function handleTyping(
  request: Request,
  config: GatewayConfig,
  dependencies: GatewayDependencies,
): Promise<Response> {
  if (
    request.method !== "POST" ||
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return new Response(null, { status: 400 });
  }

  try {
    const value = parseJson(
      await readBody(request, MAX_NOTIFICATION_BODY_BYTES),
    );
    if (!isRecord(value) || Object.keys(value).some((key) => key !== "to")) {
      return new Response(null, { status: 400 });
    }
    const destination =
      value.to === undefined
        ? undefined
        : typeof value.to === "string" && /^[a-z][a-z0-9_-]*$/.test(value.to)
          ? value.to
          : undefined;
    if (value.to !== undefined && !destination) {
      return new Response(null, { status: 400 });
    }
    const target = destinationFor(config, destination);
    if (!target) {
      return new Response(null, { status: 503 });
    }
    const result = await callTelegram(config, dependencies, "sendChatAction", {
      chat_id: target.chatId,
      action: "typing",
    });
    return new Response(null, { status: result === true ? 204 : 502 });
  } catch {
    return new Response(null, { status: 400 });
  }
}

async function handleTelegramWebhook(
  request: Request,
  config: GatewayConfig,
  dependencies: GatewayDependencies,
): Promise<Response> {
  if (
    request.method !== "POST" ||
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    return new Response(null, { status: 400 });
  }
  if (
    request.headers.get("x-telegram-bot-api-secret-token") !==
    config.webhookSecret
  ) {
    return new Response(null, { status: 401 });
  }

  let body: string;
  let update: unknown;
  try {
    body = await readBody(request, MAX_WEBHOOK_BODY_BYTES);
    update = parseJson(body);
  } catch {
    return new Response(null, { status: 400 });
  }

  const message = telegramChat(update);
  if (!message) {
    return new Response(null, { status: 204 });
  }

  const chat = message.chat as Record<string, unknown>;
  const chatId =
    typeof chat.id === "number" || typeof chat.id === "string"
      ? String(chat.id)
      : undefined;
  if (!chatId) {
    return new Response(null, { status: 204 });
  }
  const sender = isRecord(message.from) ? message.from : undefined;
  if (![...config.destinations.values()].includes(chatId)) {
    dependencies.log.warn("Unknown Telegram chat", {
      chatId,
      chatType: chat.type,
      chatTitle: chat.title,
      senderId: sender?.id,
    });
    return new Response(null, { status: 204 });
  }

  return new Response(null, { status: 204 });
}

export function createHandler(
  config: GatewayConfig,
  dependencies = defaultDependencies,
) {
  return async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/healthz" && request.method === "GET") {
      return new Response(null, { status: 204 });
    }
    if (pathname === "/v1/notifications") {
      return await handleNotification(request, config, dependencies);
    }
    if (pathname === "/v1/images") {
      return await handleMedia(request, config, dependencies, "image");
    }
    if (pathname === "/v1/voice") {
      return await handleMedia(request, config, dependencies, "voice");
    }
    if (pathname === "/v1/reactions") {
      return await handleReaction(request, config, dependencies);
    }
    if (pathname === "/v1/messages/edit") {
      return await handleMessageEdit(request, config, dependencies);
    }
    if (pathname === "/v1/typing") {
      return await handleTyping(request, config, dependencies);
    }
    if (pathname === "/v1/telegram-webhook") {
      return await handleTelegramWebhook(request, config, dependencies);
    }
    return new Response(null, { status: 404 });
  };
}

if (import.meta.main) {
  const config = loadConfig();
  const port = Number(process.env["NOTIFICATION_GATEWAY_PORT"] ?? "9087");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("NOTIFICATION_GATEWAY_PORT must be a valid TCP port");
  }
  await registerTelegramWebhook(config);
  createWebServer(createHandler(config)).listen(port, "127.0.0.1");
}
