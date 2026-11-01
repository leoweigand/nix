import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox, type Job, type Policy } from "./inbox.ts";
import { Worker } from "./worker.ts";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "assistant-worker-test-"));
  const inbox = new Inbox(directory);
  const policy: Policy = {
    ownerId: "123",
    destinations: new Map([
      ["leo", "123"],
      ["group", "-456"],
    ]),
    botUsername: "lab_bot",
  };
  let token: string | undefined;
  const messages: { endpoint: string; body: any }[] = [];
  const modelCalls: { job: Job; token?: string }[] = [];
  let needsConnection = true;
  let writes = false;
  const options = {
    secret: "test-secret",
    policy,
    inbox,
    connections: {
      begin: async (id: string) => {
        assert.equal(id, "123");
        return "https://auth.example/signin?state=private";
      },
      complete: async () => {
        token = "owner-token";
      },
      token: async (id: string) => {
        assert.equal(id, "123");
        return token;
      },
    },
    assistant: {
      answer: async (job: Job, credential?: string, onWrite?: () => void) => {
        modelCalls.push({ job: { ...job }, token: credential });
        if (writes) onWrite?.();
        return {
          text: "Dune (2021), available",
          needsConnection: !credential && needsConnection,
        };
      },
    },
    gateway: async (endpoint: string, body: unknown) => {
      messages.push({ endpoint, body });
    },
    log: { info: () => {}, error: () => {} },
  };
  const job = (id: number, group = false): Job => ({
    id,
    chatId: group ? "-456" : "123",
    senderId: "123",
    destination: group ? "group" : "leo",
    text: group ? "@lab_bot look up Dune" : "look up Dune",
    messageId: id,
    ...(group ? { topicId: 9 } : {}),
  });
  return {
    options,
    inbox,
    messages,
    modelCalls,
    job,
    setToken: () => {
      token = "owner-token";
    },
    casual: () => {
      needsConnection = false;
    },
    write: () => {
      writes = true;
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("a media request gets a DM link, persists while waiting and resumes in its original group topic", async () => {
  const f = fixture();
  try {
    f.inbox.enqueue(f.job(1, true));
    await new Worker(f.options).drain();
    assert.equal(f.inbox.jobs()[0].waitingForAuth, true);
    const delivered = f.messages.filter(
      (message) => message.endpoint !== "/v1/typing",
    );
    assert.equal(delivered[0].body.to, "leo");
    assert.match(delivered[0].body.message, /state=private/);
    assert.equal(delivered[1].body.to, "group");
    assert.doesNotMatch(delivered[1].body.message, /state=private/);
    await new Worker(f.options).drain();
    assert.equal(f.modelCalls.length, 1);
    assert.equal(
      f.messages.filter((message) => message.endpoint !== "/v1/typing").length,
      2,
    );
    const worker = new Worker(f.options);
    assert.equal(
      (
        await worker.handle(
          new Request(
            "https://webhooks.example/assistant/oauth/callback?state=test&code=test",
          ),
        )
      ).status,
      200,
    );
    // Callback dispatch is asynchronous; a later restart must also resume durably.
    while (worker.working)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await new Worker(f.options).drain();
    assert.equal(f.inbox.jobs()[0].done, true);
    assert.equal(f.modelCalls.at(-1)?.token, "owner-token");
    const result = f.messages.at(-1)!.body;
    assert.equal(result.to, "group");
    assert.equal(result.message_thread_id, 9);
    assert.equal(result.message_id, 1);
  } finally {
    f.cleanup();
  }
});
test("ordinary conversation needs no OAuth and explicit /connect sends a private link", async () => {
  const f = fixture();
  try {
    f.casual();
    f.inbox.enqueue({ ...f.job(1), text: "hello" });
    await new Worker(f.options).drain();
    assert.equal(f.inbox.jobs()[0].done, true);
    assert.equal(
      f.messages.some((m) => String(m.body.message).includes("state=private")),
      false,
    );
    f.inbox.enqueue({ ...f.job(2, true), text: "@lab_bot /connect" });
    await new Worker(f.options).drain();
    assert.equal(f.inbox.jobs()[1].done, true);
    assert.equal(
      f.messages
        .filter((m) => String(m.body.message).includes("state=private"))
        .at(-1)?.body.to,
      "leo",
    );
  } finally {
    f.cleanup();
  }
});
test("an interrupted media write is not replayed and a failed DM delivery retains the pending request", async () => {
  const f = fixture();
  try {
    f.inbox.enqueue({ ...f.job(1), writeAttempted: true });
    await new Worker(f.options).drain();
    assert.equal(f.modelCalls.length, 0);
    assert.match(f.messages[0].body.message, /won't repeat/);
    f.inbox.enqueue(f.job(2));
    const broken = {
      ...f.options,
      gateway: async () => {
        throw new Error("offline");
      },
    };
    await new Worker(broken).drain();
    assert.equal(f.inbox.jobs()[1].done, undefined);
    assert.equal(f.inbox.jobs()[1].waitingForAuth, true);
    await new Worker(f.options).drain();
    assert.equal(f.inbox.jobs()[1].authNoticeSent, true);
  } finally {
    f.cleanup();
  }
});
test("unauthorized callbacks and inbox requests cannot reach inference or mutate the queue", async () => {
  const f = fixture();
  try {
    const worker = new Worker({
      ...f.options,
      connections: {
        ...f.options.connections,
        complete: async () => {
          throw new Error("invalid");
        },
      },
    });
    assert.equal(
      (
        await worker.handle(
          new Request("http://worker/inbox", { method: "POST", body: "{}" }),
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await worker.handle(
          new Request("http://worker/assistant/oauth/callback?state=forged"),
        )
      ).status,
      400,
    );
    assert.deepEqual(f.inbox.jobs(), []);
    assert.equal(f.modelCalls.length, 0);
  } finally {
    f.cleanup();
  }
});
