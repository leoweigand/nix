import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorized, eligibleJob, Inbox, type Policy } from "./inbox.ts";
const policy: Policy = {
  ownerId: "123",
  destinations: new Map([
    ["leo", "123"],
    ["group", "-456"],
  ]),
  botUsername: "lab_bot",
};
function update(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 100,
    message: {
      message_id: 7,
      from: { id: 123 },
      chat: { id: 123, type: "private" },
      text: "Look up Dune",
      ...overrides,
    },
  };
}
test("only the owner can use the assistant in an approved DM", () => {
  assert.equal(eligibleJob(update(), policy)?.destination, "leo");
  assert.equal(eligibleJob(update({ from: { id: 999 } }), policy), undefined);
  assert.equal(
    eligibleJob(update({ chat: { id: 999, type: "private" } }), policy),
    undefined,
  );
  assert.equal(
    eligibleJob(update({ from: { id: 123, is_bot: true } }), policy),
    undefined,
  );
  assert.equal(
    eligibleJob(update({ sender_chat: { id: -456 } }), policy),
    undefined,
  );
  assert.equal(
    eligibleJob({ update_id: 100, edited_message: update().message }, policy),
    undefined,
  );
});
test("groups require an explicit mention entity and retain their topic", () => {
  const group = {
    chat: { id: -456, type: "supergroup" },
    text: "@lab_bot look up Dune",
    message_thread_id: 9,
  };
  assert.equal(eligibleJob(update(group), policy), undefined);
  assert.equal(
    eligibleJob(
      update({
        ...group,
        entities: [{ type: "mention", offset: 0, length: 8 }],
      }),
      policy,
    )?.topicId,
    9,
  );
  assert.equal(
    eligibleJob(
      update({
        ...group,
        text: "@otherbot look up Dune",
        entities: [{ type: "mention", offset: 0, length: 9 }],
      }),
      policy,
    ),
    undefined,
  );
  assert.equal(
    eligibleJob(
      update({
        ...group,
        entities: [{ type: "mention", offset: 0, length: 8 }],
        from: { id: 999 },
      }),
      policy,
    ),
    undefined,
  );
  assert.equal(
    eligibleJob(
      update({
        ...group,
        entities: [{ type: "mention", offset: 0, length: 8 }],
      }),
      { ...policy, botUsername: undefined },
    ),
    undefined,
  );
});
test("webhook authentication rejects missing, shortened, and wrong secrets", () => {
  assert.equal(authorized("secret", "secret"), true);
  for (const value of [null, "", "secre", "wrong!"])
    assert.equal(authorized(value, "secret"), false);
});
test("accepted jobs and completed receipts survive reopening without replay", () => {
  const dir = mkdtempSync(join(tmpdir(), "assistant-test-"));
  try {
    const job = eligibleJob(update(), policy)!;
    assert.equal(new Inbox(dir).enqueue(job), "accepted");
    const reopened = new Inbox(dir);
    assert.equal(reopened.enqueue(job), "duplicate");
    assert.deepEqual(reopened.jobs(), [job]);
    reopened.save({ ...job, done: true, text: "" });
    assert.equal(new Inbox(dir).enqueue(job), "duplicate");
    for (let i = 1; i <= 32; i++)
      assert.equal(reopened.enqueue({ ...job, id: 100 + i }), "accepted");
    assert.equal(reopened.enqueue({ ...job, id: 999 }), "full");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quoted messages are context and group conversation identity does not depend on the requester", () => {
  const job = eligibleJob(
    update({
      text: "Explain this",
      reply_to_message: {
        text: "Backup failed",
        from: { first_name: "Backup service" },
        date: 100,
      },
    }),
    policy,
  )!;
  assert.equal(job.message?.quote?.text, "Backup failed");
  assert.equal(job.message?.quote?.author, "Backup service");
  assert.equal(job.message?.conversationId, "123:0");
});
