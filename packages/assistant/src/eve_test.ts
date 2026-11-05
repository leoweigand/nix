import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EveAssistant } from "./eve.ts";
import { Sessions } from "./sessions.ts";
import { writeJson } from "./storage.ts";

test("Eve delivers a chosen acknowledgement before the turn settles and accepts it without text", async () => {
  const directory = mkdtempSync(join(tmpdir(), "assistant-eve-test-"));
  const sessions = new Sessions(directory, () => ({
    system: "Test assistant",
    channel: "Plain text",
    channelName: "test",
  }));
  const originalFetch = globalThis.fetch;
  const originalDestinations = process.env.TELEGRAM_DESTINATIONS;
  process.env.TELEGRAM_DESTINATIONS = "leo:123";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let acknowledge!: () => void;
  const acknowledged = new Promise<void>((resolve, reject) => {
    acknowledge = resolve;
    timeout = setTimeout(
      () => reject(new Error("Reaction was held until completion")),
      2000,
    );
  });
  let settled = false;
  const reactions: string[] = [];
  try {
    globalThis.fetch = async () => {
      writeJson(join(directory, "eve-requests", "reaction", "result.json"), {
        reaction: "👍",
      });
      await acknowledged;
      settled = true;
      return Response.json({
        status: "completed",
        reply: "",
        presentation: { reaction: "👍" },
      });
    };
    const assistant = new EveAssistant(directory, sessions);
    const message = {
      eventId: "reaction",
      conversationId: "123:0",
      kind: "human" as const,
      text: "Thanks",
      author: "Leo",
      audience: "private" as const,
      at: Date.now(),
    };
    const ref = sessions.select(message.conversationId, Date.now());
    const result = await assistant.answer(
      message,
      ref,
      undefined,
      undefined,
      async (emoji) => {
        assert.equal(settled, false);
        reactions.push(emoji);
        acknowledge();
      },
    );
    assert.deepEqual(reactions, ["👍"]);
    assert.equal(result.text, "");
    assert.equal(result.needsConnection, false);
    for (const reactionOnly of [true, false]) {
      globalThis.fetch = async () =>
        Response.json({
          status: "completed",
          reply: "Done",
          presentation: { reaction: "✅", reactionOnly },
        });
      const reply = await assistant.answer(
        { ...message, eventId: `mode-${reactionOnly}` },
        ref,
        undefined,
        undefined,
        async () => {},
      );
      assert.equal(reply.text, reactionOnly ? "" : "Done");
    }
    globalThis.fetch = async () =>
      Response.json({ status: "completed", reply: "" });
    await assert.rejects(
      assistant.answer({ ...message, eventId: "empty" }, ref),
      /no response/,
    );
  } finally {
    clearTimeout(timeout);
    globalThis.fetch = originalFetch;
    if (originalDestinations === undefined)
      delete process.env.TELEGRAM_DESTINATIONS;
    else process.env.TELEGRAM_DESTINATIONS = originalDestinations;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("follow-up context contains confirmed delivery receipts, including legacy host errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "assistant-delivery-context-"));
  const sessions = new Sessions(directory, () => ({
    system: "Test",
    channel: "Plain",
    channelName: "test",
  }));
  const originalFetch = globalThis.fetch;
  const originalDestinations = process.env.TELEGRAM_DESTINATIONS;
  process.env.TELEGRAM_DESTINATIONS = "leo:123";
  try {
    const ref = sessions.select("123:0", Date.now());
    sessions.open(ref).appendCustomMessageEntry(
      "host_reply",
      JSON.stringify({
        type: "assistant_reply",
        text: "Actual host error delivered",
      }),
      true,
    );
    sessions.open(ref).appendCustomEntry("eve-context-forwarded", {
      offset: sessions.open(ref).getEntries().length,
    });
    const assistant = new EveAssistant(directory, sessions);
    const message = {
      eventId: "explain",
      conversationId: "123:0",
      kind: "human" as const,
      text: "Explain your answer",
      author: "Leo",
      audience: "private" as const,
      at: Date.now(),
    };
    const { readFileSync } = await import("node:fs");
    let context = "";
    globalThis.fetch = async () => {
      context = JSON.stringify(
        JSON.parse(
          readFileSync(
            join(directory, "eve-requests", message.eventId, "request.json"),
            "utf8",
          ),
        ).context,
      );
      return Response.json({ status: "completed", reply: "Explained" });
    };
    await assistant.answer(message, ref);
    assert.match(context, /delivery_receipt/);
    assert.match(context, /Actual host error delivered/);
    await assistant.answer(message, ref);
    assert.equal(
      context,
      "[]",
      "Receipts are forwarded once after successful handover",
    );
    sessions.delivered(
      ref,
      "confirmed-reply",
      "Actual agent reply delivered",
      true,
    );
    await assistant.answer(message, ref);
    assert.match(context, /Actual agent reply delivered/);
    assert.doesNotMatch(context, /Actual host error delivered/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDestinations === undefined)
      delete process.env.TELEGRAM_DESTINATIONS;
    else process.env.TELEGRAM_DESTINATIONS = originalDestinations;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("transport failures still recover pending writes and empty replies retain confirmed deployment results", async () => {
  const { AssistantFailure } = await import("./failures.ts");
  const directory = mkdtempSync(join(tmpdir(), "assistant-failure-state-"));
  const sessions = new Sessions(directory, () => ({
    system: "Test",
    channel: "Plain",
    channelName: "test",
  }));
  const originalFetch = globalThis.fetch;
  const originalDestinations = process.env.TELEGRAM_DESTINATIONS;
  process.env.TELEGRAM_DESTINATIONS = "leo:123";
  const message = {
    eventId: "pending",
    conversationId: "123:0",
    kind: "human" as const,
    text: "Build an app",
    author: "Leo",
    audience: "private" as const,
    at: Date.now(),
  };
  try {
    const assistant = new EveAssistant(directory, sessions);
    const ref = sessions.select(message.conversationId, Date.now());
    const attempt = { tool: "mcp__leolab__now_deploy" };
    globalThis.fetch = async () => {
      writeJson(join(directory, "eve-requests/pending/tools.json"), {
        entries: [{ callId: "deploy", tool: attempt.tool, input: {} }],
        writeAttempt: attempt,
      });
      throw new Error("Engine transport failed");
    };
    const observed: unknown[] = [];
    await assert.rejects(
      assistant.answer(message, ref, undefined, (write) =>
        observed.push(write),
      ),
      (error: unknown) =>
        error instanceof AssistantFailure &&
        error.operations.state === "uncertain",
    );
    assert.deepEqual(observed, [attempt]);
    globalThis.fetch = async () => {
      writeJson(join(directory, "eve-requests/confirmed/tools.json"), {
        entries: [
          {
            callId: "deploy",
            tool: attempt.tool,
            input: {},
            result: {
              app: {
                active: "release",
                displayName: "Test App",
                url: "https://fixture.now.example/",
              },
            },
          },
        ],
        writeAttempt: attempt,
      });
      return Response.json({
        status: "completed",
        presentation: {
          buttons: [{ label: "Open app", url: "https://fixture.now.example/" }],
        },
      });
    };
    await assert.rejects(
      assistant.answer({ ...message, eventId: "confirmed" }, ref),
      (error: unknown) =>
        error instanceof AssistantFailure &&
        error.kind === "response" &&
        error.operations.app?.name === "Test App",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDestinations === undefined)
      delete process.env.TELEGRAM_DESTINATIONS;
    else process.env.TELEGRAM_DESTINATIONS = originalDestinations;
    rmSync(directory, { recursive: true, force: true });
  }
});
