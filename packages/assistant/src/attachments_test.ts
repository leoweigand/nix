import assert from "node:assert/strict";
import { test } from "node:test";
import { stageTelegramAttachment } from "./attachments.ts";
import { availableTools, recordWrite, DocumentWriteGuard } from "./tools.ts";
const job = {
  id: 1,
  chatId: "123",
  senderId: "123",
  destination: "leo",
  text: "File this",
  messageId: 1,
  attachment: { fileId: "telegram-file", filename: "invoice.pdf", size: 20 },
};
const attachmentId = "7be0ab20-f426-4d86-bff9-2784ce0e879b";
test("attachment transfer separates gateway secret from user OAuth and never passes file URLs to the model", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const result = await stageTelegramAttachment(
    job,
    "oauth",
    "gateway-secret",
    async (input, init) => {
      const url = String(input),
        headers = new Headers(init?.headers);
      calls.push({ url, headers });
      assert.equal(init?.redirect, "error");
      if (url.includes("9087")) {
        assert.equal(headers.get("authorization"), null);
        return new Response("%PDF-1.4");
      }
      assert.equal(headers.get("x-assistant-secret"), null);
      assert.equal(headers.get("authorization"), "Bearer oauth");
      return Response.json({ attachmentId });
    },
  );
  assert.equal(result, attachmentId);
  assert.equal(calls.length, 2);
  await assert.rejects(
    stageTelegramAttachment({ ...job, chatId: "-456" }, "oauth", "secret"),
    /Private attachment/,
  );
});
test("document tools stay out of groups and ingestion saves a receipt before execution", () => {
  const token = `e30.${Buffer.from(JSON.stringify({ scope: "documents:read documents:ingest" })).toString("base64url")}.test`;
  assert(availableTools(token).includes("mcp__leolab__search_documents"));
  assert(
    !availableTools(token, "shared").some((t) => /document|ingestion/.test(t)),
  );
  let saved: unknown;
  recordWrite(
    "mcp__leolab__ingest_document",
    { attachmentId, secret: "omit" },
    (v) => {
      saved = v;
    },
  );
  assert.deepEqual(saved, {
    tool: "mcp__leolab__ingest_document",
    attachmentId,
  });
  assert.throws(
    () =>
      recordWrite("mcp__leolab__ingest_document", { attachmentId }, () => {
        throw new Error("disk full");
      }),
    /disk full/,
  );
  const guard = new DocumentWriteGuard();
  guard.before("mcp__leolab__ingest_document", { attachmentId });
  assert.throws(
    () => guard.before("mcp__leolab__ingest_document", { attachmentId }),
    /already attempted/,
  );
});
