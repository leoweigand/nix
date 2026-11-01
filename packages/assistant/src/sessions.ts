import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readJson, writeJson } from "./storage.ts";
import { messageContent, type ConversationMessage } from "./conversation.ts";

export const MODEL_ID = "claude-haiku-5-5";
export const MESSAGE_LIMIT = 10;
export const IDLE_MS = 10 * 60_000;
export interface Instructions {
  system: string;
  channel: string;
  channelName: string;
}
interface Metadata {
  version: 1;
  conversationId: string;
  revision: string;
  instructions: Instructions;
  reason: string;
  createdAt: number;
}
interface Recorded {
  eventId: string;
  kind: "human" | "assistant" | "notification";
  at: number;
}
export interface SessionRef {
  file: string;
  id: string;
  notice?: string;
}
const META = "assistant-session";
const EVENT = "conversation-message";
export class Sessions {
  stateDir: string;
  instructions: () => Instructions;
  now: () => number;
  constructor(
    stateDir: string,
    instructions: () => Instructions,
    now = Date.now,
  ) {
    this.stateDir = stateDir;
    this.instructions = instructions;
    this.now = now;
  }
  private directory(conversationId: string) {
    return join(
      this.stateDir,
      "sessions",
      createHash("sha256").update(conversationId).digest("hex").slice(0, 24),
    );
  }
  open(ref: SessionRef): SessionManager {
    if (!ref.file.startsWith(`${join(this.stateDir, "sessions")}/`))
      throw new Error("Session is outside the assistant's storage");
    return SessionManager.open(ref.file);
  }
  metadata(manager: SessionManager): Metadata {
    const entry = manager
      .getEntries()
      .find((e) => e.type === "custom" && e.customType === META);
    if (!entry || entry.type !== "custom")
      throw new Error("Missing session instructions");
    return entry.data as Metadata;
  }
  private events(manager: SessionManager): Recorded[] {
    return manager
      .getEntries()
      .filter(
        (e) =>
          (e.type === "custom" || e.type === "custom_message") &&
          e.customType === EVENT,
      )
      .map(
        (e) =>
          (e.type === "custom_message"
            ? e.details
            : e.type === "custom"
              ? e.data
              : undefined) as Recorded,
      );
  }
  private current(conversationId: string): SessionRef | undefined {
    return readJson<SessionRef>(
      join(this.directory(conversationId), "active.json"),
    );
  }
  select(conversationId: string, at: number, reset = false): SessionRef {
    const old = this.current(conversationId);
    let reason = reset ? "manual reset" : "first message";
    if (old && !reset) {
      const manager = this.open(old);
      const events = this.events(manager);
      const last = Math.max(
        this.metadata(manager).createdAt,
        ...events.map((e) => e.at),
      );
      if (events.length >= MESSAGE_LIMIT) reason = "ten-message limit";
      else if (at - last >= IDLE_MS) reason = "ten minutes of inactivity";
      else return { file: old.file, id: old.id };
    }
    const directory = this.directory(conversationId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const cwd = join(this.stateDir, "workspace");
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const manager = SessionManager.create(cwd, directory);
    const loaded = this.instructions();
    if (
      !loaded ||
      ![loaded.system, loaded.channel, loaded.channelName].every(
        (value) => typeof value === "string" && value.trim(),
      )
    )
      throw new Error("Instruction bundle is incomplete");
    const instructions = {
      system: loaded.system,
      channel: loaded.channel,
      channelName: loaded.channelName,
    };
    const revision = createHash("sha256")
      .update(JSON.stringify(instructions))
      .digest("hex")
      .slice(0, 12);
    manager.appendCustomEntry(META, {
      version: 1,
      conversationId,
      revision,
      instructions,
      reason,
      createdAt: at,
    } satisfies Metadata);
    const notice = `New session (${reason}). Earlier conversation is not included.`;
    // Pi persists setup entries when the first message is appended. This is also the visible boundary notice.
    manager.appendMessage({
      role: "user",
      content: JSON.stringify({ type: "session_notice", text: notice }),
      timestamp: at,
    });
    const ref = {
      file: manager.getSessionFile()!,
      id: manager.getSessionId(),
      notice,
    };
    writeJson(join(directory, "active.json"), { file: ref.file, id: ref.id });
    return ref;
  }
  record(ref: SessionRef, message: ConversationMessage): boolean {
    const manager = this.open(ref);
    if (this.events(manager).some((e) => e.eventId === message.eventId))
      return false;
    manager.appendCustomMessageEntry(EVENT, messageContent(message), true, {
      eventId: message.eventId,
      kind: message.kind,
      at: message.at,
    } satisfies Recorded);
    return true;
  }
  delivered(
    ref: SessionRef,
    eventId: string,
    text: string,
    generated: boolean,
    at = this.now(),
  ): void {
    const manager = this.open(ref);
    if (this.events(manager).some((e) => e.eventId === eventId)) return;
    if (!generated)
      manager.appendCustomMessageEntry(
        "host_reply",
        JSON.stringify({ type: "assistant_reply", text }),
        true,
      );
    manager.appendCustomEntry(EVENT, {
      eventId,
      kind: "assistant",
      at,
    } satisfies Recorded);
  }
  status(conversationId: string): string {
    const ref = this.current(conversationId);
    if (!ref)
      return "No session yet. The next conversation message will start one.";
    const manager = this.open(ref),
      meta = this.metadata(manager),
      events = this.events(manager);
    const compacted = manager.getEntries().some((e) => e.type === "compaction");
    return `Session: ${ref.id.slice(-8)}\nStarted: ${new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" }).format(new Date(meta.createdAt))} (Europe/Berlin) (${meta.reason})\nMessages: ${events.length}/${MESSAGE_LIMIT}\nIdle timeout: 10 minutes\nModel: ${MODEL_ID}\nInstructions: ${meta.revision}\nChannel: ${meta.instructions.channelName}\nEarlier history summarized: ${compacted ? "yes" : "no"}`;
  }
  loadInstructions(ref: SessionRef): Instructions {
    return this.metadata(this.open(ref)).instructions;
  }
}
