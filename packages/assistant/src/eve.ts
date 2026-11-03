import { createHash } from "node:crypto";
import { decodeJwt } from "jose";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ConversationMessage } from "./conversation.ts";
import { connectionRevision } from "./connections.ts";
import { cardMarkdown, type ReplyCard } from "./replies.ts";
import type { Sessions, SessionRef } from "./sessions.ts";
import type { WriteAttempt } from "./tools.ts";
import { readJson, writeJson } from "./storage.ts";
import type { RuntimeResult, ToolJournal } from "../agent/lib/context.ts";

export class EveAssistant {
  stateDir: string;
  sessions: Sessions;
  active?: { abort(): Promise<void> };
  constructor(stateDir: string, sessions: Sessions) {
    this.stateDir = stateDir;
    this.sessions = sessions;
  }
  private directory(eventId: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(eventId)) throw new Error("Invalid event ID");
    return join(this.stateDir, "eve-requests", eventId);
  }
  writeAttempt(message: ConversationMessage): WriteAttempt | undefined {
    return readJson<ToolJournal>(
      join(this.directory(message.eventId), "tools.json"),
    )?.writeAttempt;
  }
  async answer(
    message: ConversationMessage,
    ref: SessionRef,
    _token?: string,
    onWriteAttempt: (attempt?: WriteAttempt) => void = () => {},
    react: (emoji: string) => Promise<void> = async () => {},
  ): Promise<{
    text: string;
    needsConnection: boolean;
    compacted?: boolean;
    buttons?: RuntimeResult["buttons"];
    cards?: ReplyCard[];
  }> {
    const directory = this.directory(message.eventId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const manager = this.sessions.open(ref);
    const entries = manager.getEntries();
    const forwarded = [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "eve-context-forwarded",
      );
    const offset =
      forwarded?.type === "custom"
        ? Number((forwarded.data as { offset: number }).offset)
        : 0;
    const context = entries
      .slice(offset)
      .filter(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === "conversation-message" &&
          (entry.details as { kind?: string })?.kind === "notification",
      )
      .map((entry) => (entry.type === "custom_message" ? entry.content : ""));
    const senderId = (process.env.TELEGRAM_DESTINATIONS ?? "")
      .split(",")
      .find((entry) => entry.startsWith("leo:"))
      ?.slice(4);
    if (!senderId) throw new Error("Missing Telegram sender binding");
    const grant = _token ? decodeJwt(_token) : undefined;
    const authRevision = createHash("sha256")
      .update(
        JSON.stringify([
          grant?.sub,
          grant?.scope,
          _token ? connectionRevision(this.stateDir, senderId) : "disconnected",
        ]),
      )
      .digest("hex")
      .slice(0, 12);
    writeJson(join(directory, "request.json"), {
      message,
      ref,
      context,
      senderId,
      authRevision,
    });
    writeJson(join(directory, "result.json"), {});
    const controller = new AbortController();
    this.active = { abort: async () => controller.abort() };
    // The read may time out without cancelling the accepted durable Eve delivery.
    const timer = setTimeout(() => controller.abort(), 10 * 60_000);
    try {
      const response = await fetch(
        process.env.ASSISTANT_EVE_URL ?? "http://127.0.0.1:9091/internal/turn",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-assistant-secret": process.env.TELEGRAM_WEBHOOK_SECRET!,
          },
          body: JSON.stringify({ eventId: message.eventId }),
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`Eve HTTP ${response.status}`);
      const result = (await response.json()) as {
        status: string;
        reply?: string;
        error?: unknown;
        presentation?: RuntimeResult;
      };
      manager.appendCustomEntry("eve-context-forwarded", {
        offset: entries.length,
      });
      const presentation =
        result.presentation ??
        readJson<RuntimeResult>(join(directory, "result.json")) ??
        {};
      const attempt = this.writeAttempt(message);
      if (attempt) onWriteAttempt(attempt);
      if (result.status === "failed") throw new Error("Eve inference failed");
      if (presentation.reaction) await react(presentation.reaction);
      const text =
        presentation.cards?.map(cardMarkdown).join("\n\n") ??
        result.reply?.trim();
      if (!text && !presentation.needsConnection)
        throw new Error("Eve returned no response");
      return {
        text: text ?? "Connection requested",
        needsConnection: presentation.needsConnection ?? false,
        cards: presentation.cards,
        buttons: presentation.cards ? undefined : presentation.buttons,
      };
    } finally {
      clearTimeout(timer);
      this.active = undefined;
    }
  }
}
