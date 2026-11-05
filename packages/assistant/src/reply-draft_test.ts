import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { recordReplyDraft, presentationReply } from "./reply-draft.ts";

test("only completed parent presentation text survives an empty final step", () => {
  const dir = mkdtempSync(join(tmpdir(), "assistant-draft-"));
  const text = (runId: string, value: string, partId = runId) =>
    recordReplyDraft(dir, {
      type: "content.completed",
      data: { runId, partId, value, kind: "text", phase: "narration" },
    });
  const call = (runId: string, callId: string, name: string) =>
    recordReplyDraft(dir, {
      type: "call.requested",
      data: { callId, owner: { runId }, capability: { name, kind: "tool" } },
    });
  const settle = (
    callId: string,
    outcome: "completed" | "failed" = "completed",
  ) =>
    recordReplyDraft(dir, { type: "call.settled", data: { callId, outcome } });
  try {
    text("work", "I will build it.");
    call("work", "code", "coder");
    settle("code");
    assert.equal(presentationReply(dir), undefined);
    text("answer", "The app is deployed.");
    call("answer", "button", "telegram_buttons");
    assert.equal(presentationReply(dir), undefined);
    settle("button");
    text("empty", "");
    assert.equal(presentationReply(dir), "The app is deployed.");
    text("answer", "The app is deployed.");
    assert.equal(
      presentationReply(dir),
      "The app is deployed.",
      "Replayed hooks must not duplicate text",
    );
    call("later", "write", "leolab__now_deploy");
    settle("write");
    assert.equal(
      presentationReply(dir),
      undefined,
      "Later work invalidates old narration",
    );
    call("reverse-order", "second-button", "telegram_buttons");
    settle("second-button");
    text("reverse-order", "A complete answer.");
    assert.equal(presentationReply(dir), "A complete answer.");
    text("failure", "Not ready.");
    call("failure", "bad-button", "telegram_buttons");
    settle("bad-button", "failed");
    assert.equal(presentationReply(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
