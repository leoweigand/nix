export interface Quote {
  text: string;
  author: string;
  at?: number;
}
export interface ConversationMessage {
  conversationId: string;
  eventId: string;
  text: string;
  author: string;
  audience: "private" | "shared";
  at: number;
  kind: "human" | "notification";
  quote?: Quote;
}
export function messageContent(message: ConversationMessage): string {
  return JSON.stringify({
    type:
      message.kind === "notification"
        ? "external_notification"
        : "human_message",
    author: message.author,
    time: new Date(message.at).toISOString(),
    audience: message.audience,
    text: message.text,
    ...(message.quote ? { quoted_message: message.quote } : {}),
  });
}
