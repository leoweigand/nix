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
