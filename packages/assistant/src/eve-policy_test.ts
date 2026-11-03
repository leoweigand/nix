import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareLabCall } from "../agent/lib/policy.ts";
import type { ToolJournal } from "../agent/lib/context.ts";

const home = "mcp__leolab__control_home_entities";
test("Eve policy journals write targets and refuses replay after a restart", () => {
  const journal: ToolJournal = { entries: [] };
  const input = { entityIds: ["light.fixture"], action: "turn_on" };
  assert.equal(prepareLabCall(journal, "call-1", home, input), "approved");
  assert.deepEqual(journal.writeAttempt, {
    tool: home,
    entityIds: ["light.fixture"],
    action: "turn_on",
  });
  const restarted = JSON.parse(JSON.stringify(journal));
  assert.equal(prepareLabCall(restarted, "call-1", home, input), "denied");
  assert.equal(prepareLabCall(restarted, "call-2", home, input), "denied");
  assert.equal(
    prepareLabCall(restarted, "call-3", "mcp__leolab__get_home_entity", {
      entityId: "light.fixture",
    }),
    "approved",
  );
});
test("a confirmed MCP result releases the home target but ingestion stays single-attempt", () => {
  const journal: ToolJournal = { entries: [] };
  const input = { entityIds: ["light.fixture"], action: "turn_on" };
  prepareLabCall(journal, "call-1", home, input);
  journal.entries[0].result = {
    results: [{ entityId: "light.fixture", outcome: "confirmed" }],
  };
  assert.equal(prepareLabCall(journal, "call-2", home, input), "approved");
  assert.equal(
    prepareLabCall(journal, "call-3", "mcp__leolab__ingest_document", {
      attachmentId: "attachment-fixture",
    }),
    "approved",
  );
  journal.entries[2].result = { outcome: "submitted" };
  assert.equal(
    prepareLabCall(journal, "call-4", "mcp__leolab__ingest_document", {
      attachmentId: "attachment-fixture",
    }),
    "denied",
  );
});

test("Eve send waits only for an explicitly retryable unready inbox", async () => {
  const { sendWhenReady } = await import("../agent/lib/session-ready.ts");
  let attempts = 0;
  const receipt = { deliveryId: "persisted-delivery" };
  assert.equal(
    await sendWhenReady(async () => {
      if (++attempts < 3)
        throw Object.assign(new Error("starting"), {
          code: "session_not_ready",
          retryable: true,
        });
      return receipt;
    }),
    receipt,
  );
  assert.equal(attempts, 3);
  for (const error of [
    new Error("uncertain transport failure"),
    Object.assign(new Error("inactive"), {
      code: "session_not_active",
      retryable: false,
    }),
    Object.assign(new Error("unready without retry contract"), {
      code: "session_not_ready",
    }),
  ]) {
    let calls = 0;
    await assert.rejects(
      sendWhenReady(async () => {
        calls++;
        throw error;
      }),
      (candidate) => candidate === error,
    );
    assert.equal(calls, 1);
  }
});
