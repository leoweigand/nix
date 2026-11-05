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
import { AssistantFailure, operationState } from "./failures.ts";
import { verifiedNowApps, type NowAppLink } from "./now-links.ts";

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
  operationState(message: ConversationMessage) {
    return operationState(
      readJson<ToolJournal>(
        join(this.directory(message.eventId), "tools.json"),
      ),
    );
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
    appLinks?: NowAppLink[];
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
    const receiptOffset =
      forwarded?.type === "custom"
        ? Number(
            (forwarded.data as { receiptOffset?: number }).receiptOffset ?? 0,
          )
        : 0;
    const context = entries.flatMap((entry, index) => {
      if (entry.type !== "custom_message") return [];
      if (
        index >= offset &&
        entry.customType === "conversation-message" &&
        (entry.details as { kind?: string })?.kind === "notification"
      )
        return [entry.content];
      if (index >= receiptOffset && entry.customType === "delivery_receipt")
        return [entry.content];
      if (index >= receiptOffset && entry.customType === "host_reply")
        return [
          JSON.stringify({
            type: "delivery_receipt",
            source: "host",
            text: JSON.parse(String(entry.content)).text,
          }),
        ];
      return [];
    });
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
    let sentReaction: string | undefined;
    const flushReaction = async (presentation?: RuntimeResult) => {
      const emoji = (
        presentation ?? readJson<RuntimeResult>(join(directory, "result.json"))
      )?.reaction;
      if (emoji && emoji !== sentReaction) {
        await react(emoji);
        sentReaction = emoji;
      }
    };
    // Eve writes presentation while the turn runs; acknowledgements must reach
    // Telegram before the final answer. Serialise sends to avoid duplicate polls.
    let reactionDelivery = Promise.resolve();
    const reactionTimer = setInterval(() => {
      reactionDelivery = reactionDelivery
        .then(() => flushReaction())
        .catch(() => {});
    }, 250);
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
        receiptOffset: entries.length,
      });
      const presentation =
        result.presentation ??
        readJson<RuntimeResult>(join(directory, "result.json")) ??
        {};
      const attempt = this.writeAttempt(message);
      if (attempt) onWriteAttempt(attempt);
      if (result.status === "failed")
        throw new AssistantFailure("generation", this.operationState(message));
      clearInterval(reactionTimer);
      await reactionDelivery;
      await flushReaction(presentation);
      const text =
        presentation.cards?.map(cardMarkdown).join("\n\n") ??
        result.reply?.trim();
      if (!text && !sentReaction && !presentation.needsConnection)
        throw new AssistantFailure("response", this.operationState(message));
      return {
        text:
          presentation.reactionOnly &&
          sentReaction &&
          !presentation.cards?.length &&
          !presentation.needsConnection
            ? ""
            : (text ??
              (presentation.needsConnection ? "Connection requested" : "")),
        needsConnection: presentation.needsConnection ?? false,
        cards: presentation.cards,
        buttons: presentation.cards ? undefined : presentation.buttons,
        appLinks: verifiedNowApps(
          readJson<ToolJournal>(join(directory, "tools.json")),
        ),
      };
    } catch (error) {
      // The transport can fail after a durable tool call. Inspect its journal
      // even when no successful engine response reached this process.
      const attempt = this.writeAttempt(message);
      if (attempt) onWriteAttempt(attempt);
      throw error instanceof AssistantFailure
        ? error
        : new AssistantFailure("generation", this.operationState(message));
    } finally {
      clearTimeout(timer);
      clearInterval(reactionTimer);
      await reactionDelivery;
      this.active = undefined;
    }
  }
}
