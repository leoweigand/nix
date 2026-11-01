import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inbox, type Job, type Policy } from "./inbox.ts";
import { Sessions, type SessionRef } from "./sessions.ts";
import type { ConversationMessage } from "./conversation.ts";
import { Worker } from "./worker.ts";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "assistant-worker-test-"));
  const inbox = new Inbox(join(directory, "inbox"));
  const sessions = new Sessions(directory, () => ({
    system: "Test assistant",
    channel: "Plain text",
    channelName: "test",
  }));
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
  const modelCalls: { job: ConversationMessage; token?: string }[] = [];
  let needsConnection = true;
  let writes = false;
  let react = false;
  const options = {
    secret: "test-secret",
    sessions,
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
      answer: async (
        job: ConversationMessage,
        _ref: SessionRef,
        credential?: string,
        onWrite?: () => void,
        onReact?: (emoji: string) => Promise<void>,
      ) => {
        modelCalls.push({ job: { ...job }, token: credential });
        if (writes) onWrite?.();
        if (react) await onReact?.("👍");
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
    sessions,
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
    react: () => {
      react = true;
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("the reaction tool is bound to the incoming message and conversation", async () => {
  const f = fixture();
  try {
    f.casual();
    f.react();
    f.inbox.enqueue(f.job(7, true));
    await new Worker(f.options).drain();
    assert.deepEqual(
      f.messages.find((m) => m.endpoint === "/v1/reactions")?.body,
      {
        to: "group",
        message_id: 7,
        emoji: "👍",
      },
    );
  } finally {
    f.cleanup();
  }
});
test("button choices are bound to the owner and chat, expire, and accept only one selection", async () => {
  const f = fixture();
  try {
    const source = {
      ...f.job(21, true),
      done: true,
      buttons: [
        { label: "Select Dune (2021)", token: "abcdefghijklmnopqrstuvwx" },
        { label: "Select Dune (1984)", token: "zyxwvutsrqponmlkjihgfedc" },
      ],
      buttonsExpireAt: Date.now() + 60000,
    };
    f.inbox.enqueue(source);
    const worker = new Worker(f.options);
    worker.drain = async () => {};
    const press = (sender: number, chat: number, token: string) =>
      worker.handle(
        new Request("http://worker/inbox", {
          method: "POST",
          headers: { "x-assistant-secret": "test-secret" },
          body: JSON.stringify({
            update_id: 99,
            callback_query: {
              from: { id: sender },
              data: token,
              message: { message_id: 100, chat: { id: chat } },
            },
          }),
        }),
      );
    await press(999, -456, source.buttons[0].token);
    await press(123, -999, source.buttons[0].token);
    assert.equal(f.inbox.jobs().length, 1);
    await press(123, -456, source.buttons[0].token);
    await press(123, -456, source.buttons[1].token);
    assert.equal(f.inbox.jobs().length, 2);
    assert.equal(
      f.inbox.jobs().find((job) => job.id === "choice-21")?.text,
      "Select Dune (2021)",
    );
  } finally {
    f.cleanup();
  }
});
test("a media request gets a private group link, persists while waiting and resumes in its original group topic", async () => {
  const f = fixture();
  try {
    f.inbox.enqueue(f.job(1, true));
    await new Worker(f.options).drain();
    assert.equal(f.inbox.jobs()[0].waitingForAuth, true);
    const delivered = f.messages.filter(
      (message) =>
        message.endpoint !== "/v1/typing" &&
        !String(message.body.message).startsWith("New session"),
    );
    assert.equal(delivered[0].body.to, "group");
    assert.equal(delivered[0].body.ephemeral_receiver, "123");
    assert.match(delivered[0].body.message, /state=private/);
    await new Worker(f.options).drain();
    assert.equal(f.modelCalls.length, 1);
    assert.equal(
      f.messages.filter(
        (message) =>
          message.endpoint !== "/v1/typing" &&
          !String(message.body.message).startsWith("New session"),
      ).length,
      1,
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
      "group",
    );
    assert.equal(
      f.messages
        .filter((m) => String(m.body.message).includes("state=private"))
        .at(-1)?.body.ephemeral_receiver,
      "123",
    );
  } finally {
    f.cleanup();
  }
});
test("group OAuth falls back to a DM if Telegram rejects ephemeral delivery", async () => {
  const f = fixture();
  try {
    f.inbox.enqueue(f.job(4, true));
    const worker = new Worker({
      ...f.options,
      gateway: async (endpoint, body: any) => {
        if (body.ephemeral_receiver)
          throw new Error("Telegram rejected ephemeral message");
        await f.options.gateway(endpoint, body);
      },
    });
    await worker.drain();
    const link = f.messages.find((m) =>
      String(m.body.message).includes("state=private"),
    );
    assert.equal(link?.body.to, "leo");
    assert.equal(
      f.messages.some(
        (m) =>
          m.body.to === "group" &&
          String(m.body.message).includes("state=private"),
      ),
      false,
    );
    assert.equal(f.inbox.jobs()[0].waitingForAuth, true);
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
    assert.match(
      f.messages.find((m) => String(m.body.message).includes("won't repeat"))!
        .body.message,
      /won't repeat/,
    );
    f.inbox.enqueue(f.job(2));
    const broken = {
      ...f.options,
      gateway: async (endpoint: string, body: any) => {
        if (String(body.message).includes("state=private"))
          throw new Error("offline");
        await f.options.gateway(endpoint, body);
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

test("notification ingestion never invokes the agent and /session reports the persistent counter", async () => {
  const f = fixture();
  try {
    const worker = new Worker(f.options);
    const response = await worker.handle(
      new Request("http://worker/inbox", {
        method: "POST",
        headers: { "x-assistant-secret": "test-secret" },
        body: JSON.stringify({
          type: "notification",
          chatId: "123",
          messageId: 70,
          text: "Backup failed",
          at: Date.now(),
        }),
      }),
    );
    assert.equal(response.status, 204);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await worker.drain();
    while (worker.working) await new Promise((r) => setTimeout(r, 5));
    assert.equal(f.modelCalls.length, 0);
    assert.match(f.sessions.status("123:0"), /Messages: 1\/10/);
    f.inbox.enqueue({ ...f.job(80), text: "/session" });
    await worker.drain();
    assert.equal(f.modelCalls.length, 0);
    assert.match(f.messages.at(-1)!.body.message, /Messages: 1\/10/);
  } finally {
    f.cleanup();
  }
});

test("notifications and resets proceed while a human request waits for OAuth, without moving the paused request", async () => {
  const f = fixture();
  try {
    f.inbox.enqueue(f.job(1));
    await new Worker(f.options).drain();
    const original = f.inbox.jobs()[0].session!;
    const notification = {
      ...f.job(2),
      id: "notification-123-2",
      kind: "notification" as const,
      message: {
        conversationId: "123:0",
        eventId: "notification-123-2",
        kind: "notification" as const,
        text: "Backup succeeded",
        author: "Backup",
        audience: "private" as const,
        at: Date.now(),
      },
    };
    f.inbox.enqueue(notification);
    await new Worker(f.options).drain();
    assert.equal(
      f.inbox.jobs().find((j) => j.id === notification.id)?.done,
      true,
    );
    assert.match(f.sessions.status("123:0"), /Messages: 2\/10/);
    f.inbox.enqueue({ ...f.job(3), text: "/reset" });
    await new Worker(f.options).drain();
    const fresh = f.sessions.select("123:0", Date.now());
    assert.notEqual(fresh.file, original.file);
    f.setToken();
    await new Worker(f.options).drain();
    assert.equal(f.inbox.jobs().find((j) => j.id === 1)?.done, true);
    assert.equal(
      f.inbox.jobs().find((j) => j.id === 1)?.session?.file,
      original.file,
    );
    assert.equal(f.sessions.select("123:0", Date.now()).file, fresh.file);
  } finally {
    f.cleanup();
  }
});
