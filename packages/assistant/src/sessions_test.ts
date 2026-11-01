import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sessions, IDLE_MS } from "./sessions.ts";
import type { ConversationMessage } from "./conversation.ts";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "assistant-sessions-"));
  let now = 1_800_000_000_000;
  let instructions = {
    system: "First instructions",
    channel: "Plain text",
    channelName: "test",
  };
  const sessions = new Sessions(
    directory,
    () => ({ ...instructions }),
    () => now,
  );
  const message = (
    n: number,
    kind: "human" | "notification" = "human",
  ): ConversationMessage => ({
    conversationId: "chat",
    eventId: `event-${n}`,
    kind,
    text: `message ${n}`,
    author: "Leo",
    audience: "private",
    at: now,
  });
  return {
    directory,
    sessions,
    message,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    change: () => {
      instructions = { ...instructions, system: "New instructions" };
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("ten visible messages rotate a session without copying history, while tool entries do not count", () => {
  const f = fixture();
  try {
    const ref = f.sessions.select("chat", f.now());
    for (let i = 0; i < 5; i++) {
      f.sessions.record(ref, f.message(i));
      f.sessions
        .open(ref)
        .appendCustomEntry("tool-observation", { count: 999 });
      f.sessions.delivered(ref, `reply-${i}`, `reply ${i}`, false);
    }
    assert.match(f.sessions.status("chat"), /Messages: 10\/10/);
    const next = f.sessions.select("chat", f.now());
    assert.notEqual(next.id, ref.id);
    assert.equal(next.notice, "🐾");
    assert.equal(
      f.sessions.metadata(f.sessions.open(next)).reason,
      "ten-message limit",
    );
    assert.equal(
      f.sessions
        .open(next)
        .getEntries()
        .some(
          (e) =>
            e.type === "custom_message" &&
            e.customType === "conversation-message",
        ),
      false,
    );
    assert.equal(
      f.sessions
        .open(ref)
        .getEntries()
        .filter(
          (e) =>
            e.type === "custom_message" &&
            e.customType === "conversation-message",
        ).length,
      5,
    );
  } finally {
    f.cleanup();
  }
});
test("inactivity is measured from the latest conversation message and survives restart", () => {
  const f = fixture();
  try {
    const ref = f.sessions.select("chat", f.now());
    f.sessions.record(ref, f.message(1));
    f.advance(IDLE_MS - 1);
    assert.equal(f.sessions.select("chat", f.now()).id, ref.id);
    f.sessions.delivered(ref, "reply", "ok", false);
    f.advance(IDLE_MS - 1);
    assert.equal(f.sessions.select("chat", f.now()).id, ref.id);
    f.advance(1);
    const restarted = new Sessions(f.directory, f.sessions.instructions, () =>
      f.now(),
    );
    const next = restarted.select("chat", f.now());
    assert.notEqual(next.id, ref.id);
    assert.equal(next.notice, "🐾");
    assert.equal(
      f.sessions.metadata(f.sessions.open(next)).reason,
      "ten minutes of inactivity",
    );
  } finally {
    f.cleanup();
  }
});
test("instruction revisions are pinned, reset reloads them, and an old request can still finish in its pinned session", () => {
  const f = fixture();
  try {
    const old = f.sessions.select("chat", f.now());
    f.sessions.record(old, f.message(1));
    f.change();
    assert.equal(f.sessions.select("chat", f.now()).id, old.id);
    assert.equal(f.sessions.loadInstructions(old).system, "First instructions");
    const next = f.sessions.select("chat", f.now(), true);
    assert.equal(next.notice, "🐾");
    const context = JSON.stringify(
      f.sessions.open(next).buildSessionContext().messages,
    );
    assert.match(context, /manual reset/);
    assert.match(context, /Earlier conversation is not included/);
    assert.equal(f.sessions.loadInstructions(next).system, "New instructions");
    f.sessions.delivered(old, "late-reply", "Finished old request", false);
    assert.equal(f.sessions.select("chat", f.now()).id, next.id);
    assert.notEqual(
      f.sessions.metadata(f.sessions.open(old)).revision,
      f.sessions.metadata(f.sessions.open(next)).revision,
    );
  } finally {
    f.cleanup();
  }
});
test("notifications are durable context, count once, and do not need an agent run", () => {
  const f = fixture();
  try {
    const ref = f.sessions.select("chat", f.now());
    const notification = f.message(1, "notification");
    assert.equal(f.sessions.record(ref, notification), true);
    assert.equal(f.sessions.record(ref, notification), false);
    const restarted = new Sessions(f.directory, f.sessions.instructions, () =>
      f.now(),
    );
    assert.match(restarted.status("chat"), /Messages: 1\/10/);
    const context = restarted.open(ref).buildSessionContext().messages;
    assert.match(JSON.stringify(context), /external_notification/);
    assert.match(JSON.stringify(context), /message 1/);
    assert.equal(
      restarted
        .open(ref)
        .getEntries()
        .some((e) => e.type === "message" && e.message.role === "assistant"),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("a running exchange can finish across the message limit before the next incoming message rotates", () => {
  const f = fixture();
  try {
    const ref = f.sessions.select("chat", f.now());
    for (let i = 0; i < 9; i++)
      f.sessions.record(ref, f.message(i, "notification"));
    assert.equal(f.sessions.select("chat", f.now()).id, ref.id);
    f.sessions.record(ref, f.message(10));
    f.sessions.delivered(ref, "reply-10", "Completed the request", false);
    assert.match(f.sessions.status("chat"), /Messages: 11\/10/);
    assert.notEqual(f.sessions.select("chat", f.now()).id, ref.id);
  } finally {
    f.cleanup();
  }
});
