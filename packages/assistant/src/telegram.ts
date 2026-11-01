import type { Job, Policy } from "./inbox.ts";
import type { ConversationMessage } from "./conversation.ts";
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function eligibleJob(update: unknown, policy: Policy): Job | undefined {
  if (
    !record(update) ||
    !Number.isSafeInteger(update.update_id) ||
    (update.update_id as number) < 0 ||
    !record(update.message)
  )
    return;
  const m = update.message;
  let attachment: Job["attachment"];
  if (
    record(m.document) &&
    typeof m.document.file_id === "string" &&
    ["application/pdf", "image/jpeg", "image/png", "image/webp"].includes(
      String(m.document.mime_type),
    ) &&
    typeof m.document.file_size === "number"
  ) {
    attachment = {
      fileId: m.document.file_id,
      filename:
        typeof m.document.file_name === "string"
          ? m.document.file_name.slice(0, 200)
          : "document",
      size: m.document.file_size,
    };
  } else if (Array.isArray(m.photo)) {
    const photo = m.photo
      .filter(
        (p) =>
          record(p) &&
          typeof p.file_id === "string" &&
          typeof p.file_size === "number",
      )
      .at(-1);
    if (photo)
      attachment = {
        fileId: photo.file_id,
        filename: "photo.jpg",
        size: photo.file_size,
      };
  }
  if (
    attachment &&
    (!/^[a-zA-Z0-9_-]{1,500}$/.test(attachment.fileId) ||
      attachment.size <= 0 ||
      attachment.size > 20 * 1024 * 1024)
  )
    return;
  // Documents are accepted only in the owner's private conversation.
  if (attachment && (!record(m.chat) || m.chat.type !== "private")) return;
  const text =
    typeof m.text === "string"
      ? m.text
      : typeof m.caption === "string"
        ? m.caption
        : attachment
          ? "[Attachment received without filing instructions. Ask what the user wants to do with it.]"
          : "";
  if (
    !record(m.chat) ||
    !record(m.from) ||
    m.from.is_bot ||
    m.sender_chat ||
    String(m.from.id) !== policy.ownerId ||
    !text.trim() ||
    text.length > 8000 ||
    !Number.isSafeInteger(m.message_id)
  )
    return;
  const chatId = String(m.chat.id);
  const destination = [...policy.destinations].find(
    ([, id]) => id === chatId,
  )?.[0];
  if (!destination) return;
  if (m.chat.type === "private") {
    if (chatId !== policy.ownerId) return;
  } else if (m.chat.type === "group" || m.chat.type === "supergroup") {
    if (
      !policy.botUsername ||
      !Array.isArray(m.entities) ||
      !m.entities.some(
        (e) =>
          record(e) &&
          e.type === "mention" &&
          typeof e.offset === "number" &&
          typeof e.length === "number" &&
          m
            .text!.toString()
            .slice(e.offset, e.offset + e.length)
            .toLowerCase() === `@${policy.botUsername!.toLowerCase()}`,
      )
    )
      return;
  } else return;
  return {
    id: update.update_id as number,
    chatId,
    senderId: policy.ownerId,
    destination,
    text,
    ...(attachment ? { attachment } : {}),
    receivedAt: Date.now(),
    message: {
      conversationId: `${chatId}:${Number.isSafeInteger(m.message_thread_id) ? m.message_thread_id : 0}`,
      eventId: `human-${update.update_id}`,
      kind: "human",
      text,
      author:
        [m.from.first_name, m.from.last_name]
          .filter((x) => typeof x === "string")
          .join(" ") ||
        (typeof m.from.username === "string" ? m.from.username : "Leo"),
      audience: m.chat.type === "private" ? "private" : "shared",
      at: typeof m.date === "number" ? m.date * 1000 : Date.now(),
      ...(record(m.reply_to_message) &&
      typeof m.reply_to_message.text === "string"
        ? {
            quote: {
              text: m.reply_to_message.text.slice(0, 8000),
              author:
                record(m.reply_to_message.from) &&
                typeof m.reply_to_message.from.first_name === "string"
                  ? m.reply_to_message.from.first_name
                  : "External message",
              ...(typeof m.reply_to_message.date === "number"
                ? { at: m.reply_to_message.date * 1000 }
                : {}),
            },
          }
        : {}),
    },
    messageId: m.message_id as number,
    ...(Number.isSafeInteger(m.message_thread_id)
      ? { topicId: m.message_thread_id as number }
      : {}),
  };
}

export function messageForJob(job: Job): ConversationMessage {
  const message = job.message ?? {
    conversationId: `${job.chatId}:${job.topicId ?? 0}`,
    eventId: `human-${job.id}`,
    kind: "human",
    text: job.text,
    author: "Leo",
    audience: job.chatId === job.senderId ? "private" : "shared",
    at: job.receivedAt ?? Date.now(),
  };
  return {
    ...message,
    ...(job.attachmentId && job.attachment
      ? {
          attachment: {
            attachmentId: job.attachmentId,
            filename: job.attachment.filename,
          },
        }
      : {}),
  };
}
export function notificationJob(
  value: unknown,
  policy: Policy,
): Job | undefined {
  if (
    !record(value) ||
    value.type !== "notification" ||
    typeof value.chatId !== "string" ||
    typeof value.text !== "string" ||
    value.text.length > 8000 ||
    typeof value.messageId !== "number" ||
    !Number.isSafeInteger(value.messageId) ||
    typeof value.at !== "number"
  )
    return;
  const destination = [...policy.destinations].find(
    ([, id]) => id === value.chatId,
  )?.[0];
  if (!destination) return;
  const id = `notification-${value.chatId}-${value.messageId}`;
  return {
    id,
    kind: "notification",
    chatId: value.chatId,
    senderId: policy.ownerId,
    destination,
    text: value.text,
    messageId: value.messageId,
    receivedAt: Date.now(),
    message: {
      conversationId: `${value.chatId}:0`,
      eventId: id,
      kind: "notification",
      text: value.text,
      author: "Notification gateway",
      audience: value.chatId === policy.ownerId ? "private" : "shared",
      at: value.at,
    },
  };
}
