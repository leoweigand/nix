import { ContextOutbox, type NotificationContext } from "./context-outbox.ts";
import { restrictedFetch } from "../../runtime/network.ts";
import { createWebServer } from "../../runtime/http.ts";

const automationFetch = restrictedFetch([
  "https://api.telegram.org",
  "http://127.0.0.1:9090",
]);

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
  assistantEnabled?: boolean;
}

interface GatewayDependencies {
  fetch: typeof fetch;
  log: Pick<Console, "info" | "warn" | "error">;
  recordContext?: (event: NotificationContext) => void;
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
    TELEGRAM_ASSISTANT_ENABLED: process.env["TELEGRAM_ASSISTANT_ENABLED"],
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
    assistantEnabled: environment["TELEGRAM_ASSISTANT_ENABLED"] === "true",
  };
}

function recordNotification(
  config: GatewayConfig,
  dependencies: GatewayDependencies,
  chatId: string,
  messageId: number,
  text: string,
) {
  if (!config.assistantEnabled) return;
  try {
    dependencies.recordContext?.({
      type: "notification",
      chatId,
      messageId,
      text,
      at: Date.now(),
    });
  } catch {
    dependencies.log.error(
      "Notification delivered but context could not be queued",
    );
  }
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
            "callback_query",
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
  if (
    isRecord(update.callback_query) &&
    isRecord(update.callback_query.message) &&
    isRecord(update.callback_query.message.chat)
  )
    return update.callback_query.message;
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
    recordNotification(
      config,
      dependencies,
      destination.chatId,
      messageId,
      notification.message,
    );
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
    recordNotification(
      config,
      dependencies,
      destination.chatId,
      result.message_id,
      `[${kind} message]${notification.caption ? " " + notification.caption : ""}`,
    );
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

  if (
    config.assistantEnabled &&
    isRecord(update) &&
    (isRecord(update.message) || isRecord(update.callback_query))
  ) {
    try {
      const response = await dependencies.fetch("http://127.0.0.1:9090/inbox", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-assistant-secret": config.webhookSecret,
        },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return new Response(null, { status: 503 });
      if (
        isRecord(update.callback_query) &&
        typeof update.callback_query.id === "string"
      ) {
        await callTelegram(config, dependencies, "answerCallbackQuery", {
          callback_query_id: update.callback_query.id,
        }).catch(() => {});
      }
    } catch {
      return new Response(null, { status: 503 });
    }
  }
  return new Response(null, { status: 204 });
}

async function handleAssistantReply(
  request: Request,
  config: GatewayConfig,
  dependencies: GatewayDependencies,
): Promise<Response> {
  if (!config.assistantEnabled || request.method !== "POST")
    return new Response(null, { status: 404 });
  try {
    const value = parseJson(await readBody(request, 64 * 1024));
    if (!isRecord(value) || value.secret !== config.webhookSecret)
      return new Response(null, { status: 401 });
    const chatId =
      typeof value.to === "string"
        ? config.destinations.get(value.to)
        : undefined;
    if (
      !chatId ||
      typeof value.message !== "string" ||
      !value.message.trim() ||
      (value.rich !== undefined && typeof value.rich !== "boolean") ||
      (value.buttons !== undefined &&
        (!Array.isArray(value.buttons) ||
          value.buttons.length > 6 ||
          value.buttons.some(
            (button: unknown) =>
              !isRecord(button) ||
              typeof button.label !== "string" ||
              !button.label.trim() ||
              button.label.length > 80 ||
              (typeof button.url === "string"
                ? !URL.canParse(button.url) ||
                  new URL(button.url).protocol !== "https:" ||
                  button.url.length > 2048 ||
                  button.token !== undefined
                : typeof button.token !== "string" ||
                  !/^[A-Za-z0-9_-]{24}$/.test(button.token)),
          ))) ||
      (value.message_id !== undefined &&
        (!Number.isSafeInteger(value.message_id) ||
          (value.message_id as number) < 1)) ||
      (value.message_thread_id !== undefined &&
        !Number.isSafeInteger(value.message_thread_id)) ||
      (value.ephemeral_receiver !== undefined &&
        (typeof value.ephemeral_receiver !== "string" ||
          value.ephemeral_receiver !== config.destinations.get("leo") ||
          !/^\d+$/.test(value.ephemeral_receiver) ||
          !/^-\d+$/.test(chatId) ||
          chatId === value.ephemeral_receiver ||
          !Number.isSafeInteger(Number(value.ephemeral_receiver))))
    )
      return new Response(null, { status: 400 });
    const replyMarkup =
      Array.isArray(value.buttons) && value.buttons.length
        ? {
            inline_keyboard: value.buttons.map(
              (button: { label: string; url?: string; token?: string }) => [
                {
                  text: button.label,
                  ...(button.url
                    ? { url: button.url }
                    : { callback_data: button.token }),
                },
              ],
            ),
          }
        : undefined;
    if (
      value.rich === true &&
      value.ephemeral_receiver === undefined &&
      Buffer.byteLength(value.message, "utf8") <= 30000
    ) {
      const response = await dependencies.fetch(
        `https://api.telegram.org/bot${config.telegramBotToken}/sendRichMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            rich_message: { markdown: value.message },
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            ...(value.message_id === undefined
              ? {}
              : {
                  reply_parameters: {
                    message_id: value.message_id,
                    allow_sending_without_reply: true,
                  },
                }),
            ...(value.message_thread_id === undefined
              ? {}
              : { message_thread_id: value.message_thread_id }),
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      const result: unknown = await response.json();
      if (response.ok && isRecord(result) && result.ok === true)
        return new Response(null, { status: 204 });
      // Only a definite Telegram rejection permits a plain-text fallback. An ambiguous
      // transport error must be retried by the caller to avoid a second delivery here.
      if (!isRecord(result) || result.ok !== false)
        return new Response(null, { status: 502 });
    }
    // Keep spoilers hidden even if Telegram cannot render the rich reply.
    const plain =
      value.rich === true
        ? value.message
            .replace(/\|\|[\s\S]*?\|\|/g, "[spoiler omitted]")
            .replace(/!\[([^\]]*)\]\(tg:\/\/time\?[^)]*\)/g, "$1")
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1 ($2)")
            .replace(/<[^>]+>/g, "")
            .replace(/\*\*|__|```/g, "")
        : value.message;
    const characters = Array.from(plain.trim() ? plain : "[Media unavailable]");
    for (let offset = 0; offset < characters.length; offset += 3500) {
      const response = await dependencies.fetch(
        `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: characters.slice(offset, offset + 3500).join(""),
            ...(replyMarkup && offset === 0
              ? { reply_markup: replyMarkup }
              : {}),
            ...(value.ephemeral_receiver === undefined
              ? {}
              : {
                  ephemeral_message_parameters: {
                    receiver_user_id: Number(value.ephemeral_receiver),
                  },
                }),
            ...(value.message_id === undefined ||
            value.ephemeral_receiver !== undefined
              ? {}
              : {
                  reply_parameters: {
                    message_id: value.message_id,
                    allow_sending_without_reply: true,
                  },
                }),
            ...(value.message_thread_id === undefined
              ? {}
              : { message_thread_id: value.message_thread_id }),
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      const result: unknown = await response.json();
      if (!response.ok || !isRecord(result) || result.ok !== true)
        return new Response(null, { status: 502 });
    }
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 400 });
  }
}

// Only the trusted worker can fetch Telegram bytes; the model never receives bot URLs/tokens.
async function handleAssistantAttachment(
  request: Request,
  config: GatewayConfig,
  dependencies: GatewayDependencies,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (
    !config.assistantEnabled ||
    request.headers.get("x-assistant-secret") !== config.webhookSecret
  )
    return new Response(null, { status: 401 });
  try {
    const body = await readBody(request, MAX_NOTIFICATION_BODY_BYTES);
    const value = JSON.parse(body);
    if (
      !isRecord(value) ||
      typeof value.fileId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,500}$/.test(value.fileId)
    )
      return new Response(null, { status: 400 });
    const response = await dependencies.fetch(
      `https://api.telegram.org/bot${config.telegramBotToken}/getFile`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file_id: value.fileId }),
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      },
    );
    const info: unknown = await response.json();
    if (
      !response.ok ||
      !isRecord(info) ||
      info.ok !== true ||
      !isRecord(info.result)
    )
      return new Response(null, { status: 502 });
    const file = info.result;
    if (
      typeof file.file_path !== "string" ||
      !/^[a-zA-Z0-9_/-]+\.[a-zA-Z0-9]+$/.test(file.file_path) ||
      file.file_path.split("/").includes("..") ||
      typeof file.file_size !== "number" ||
      file.file_size > 20 * 1024 * 1024
    )
      return new Response(null, { status: 413 });
    const download = await dependencies.fetch(
      `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`,
      { redirect: "error", signal: AbortSignal.timeout(30000) },
    );
    if (!download.ok) {
      await download.body?.cancel();
      return new Response(null, { status: 502 });
    }
    const reader = download.body?.getReader();
    if (!reader) return new Response(null, { status: 502 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 20 * 1024 * 1024) {
          await reader.cancel();
          return new Response(null, { status: 413 });
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return new Response(Buffer.concat(chunks), {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response(null, { status: 502 });
  }
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
    if (pathname === "/v1/assistant-attachments")
      return handleAssistantAttachment(request, config, dependencies);
    if (pathname === "/v1/assistant-replies") {
      return await handleAssistantReply(request, config, dependencies);
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
  const outbox = config.assistantEnabled
    ? new ContextOutbox(
        process.env.NOTIFICATION_CONTEXT_DIR ??
          "/var/lib/notification-gateway/context",
        config.webhookSecret,
        automationFetch,
      )
    : undefined;
  if (outbox) {
    void outbox.flush();
    setInterval(() => void outbox.flush(), 5000);
  }
  createWebServer(
    createHandler(config, {
      ...defaultDependencies,
      recordContext: (event) => {
        outbox?.enqueue(event);
        setImmediate(() => void outbox?.flush());
      },
    }),
  ).listen(port, "127.0.0.1");
}
