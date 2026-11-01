import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextOutbox } from "./context-outbox.ts";
test("delivered notification context survives an assistant outage and drains on recovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "notification-context-"));
  try {
    const calls: unknown[] = [];
    let online = false;
    const transport: typeof fetch = async (_input, init) => {
      assert.equal(
        new Headers(init?.headers).get("x-assistant-secret"),
        "test-secret",
      );
      calls.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: online ? 204 : 503 });
    };
    const outbox = new ContextOutbox(directory, "test-secret", transport);
    outbox.enqueue({
      type: "notification",
      chatId: "123",
      messageId: 7,
      text: "Backup failed",
      at: 100,
    });
    await outbox.flush();
    assert.equal(readdirSync(directory).length, 1);
    online = true;
    await new ContextOutbox(directory, "test-secret", transport).flush();
    assert.equal(readdirSync(directory).length, 0);
    assert.equal(calls.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
