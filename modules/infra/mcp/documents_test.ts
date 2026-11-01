import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  DocumentAccess,
  DocumentService,
  documentSearchSchema,
  documentDetailsSchema,
  documentMime,
} from "./documents.ts";
const signal = () => AbortSignal.timeout(10000);
const token = "paperless-test-token";
const auth = (scope = "documents:read"): AuthInfo => ({
  token: "user-access-token",
  clientId: "codex",
  scopes: ["openid", "groups", scope],
  extra: { subject: "leo" },
});
const pdf = Buffer.from("%PDF-1.4\nfixture");
const taskId = "7be0ab20-f426-4d86-bff9-2784ce0e879b";
const document = {
  id: 42,
  title: "Washing machine invoice",
  content: "Machine bought in Berlin",
  created: "2026-01-01",
  correspondent: 2,
  tags: [1],
  __search_hit__: { highlights: "<span>Machine</span> bought" },
};
function fixture(request?: typeof fetch) {
  const directory = mkdtempSync(join(tmpdir(), "paperless-mcp-"));
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const backend: typeof fetch =
    request ??
    (async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, init });
      assert.equal(url.origin, "http://127.0.0.1:28981");
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `Token ${token}`,
      );
      assert.equal(init?.redirect, "error");
      if (url.pathname === "/api/documents/post_document/")
        return Response.json(taskId);
      if (url.pathname === "/api/tasks/")
        return Response.json([
          { task_id: taskId, status: "SUCCESS", related_document: "42" },
        ]);
      if (url.pathname === "/api/documents/42/") return Response.json(document);
      return Response.json({
        count: 1,
        results: [document],
        next: "https://evil.test",
      });
    });
  const config = {
    url: "http://127.0.0.1:28981",
    publicUrl: "https://documents.example.test",
    token,
    stateDir: directory,
  };
  return {
    service: new DocumentService(config, backend),
    config,
    backend,
    calls,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("document access requires scope and matching admins membership from trusted UserInfo", async () => {
  let calls = 0;
  let userinfo: unknown = { sub: "leo", groups: ["admins"] };
  const access = new DocumentAccess(
    "https://auth.example.test",
    "admins",
    async (input, init) => {
      calls++;
      assert.equal(
        String(input),
        "https://auth.example.test/api/oidc/userinfo",
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer user-access-token",
      );
      assert.equal(init?.redirect, "error");
      return Response.json(userinfo);
    },
  );
  assert.equal(await access.require(auth(), "documents:read", signal()), "leo");
  await assert.rejects(
    access.require(auth("media:read"), "documents:read", signal()),
    /missing_scope/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    access.require(
      { ...auth(), scopes: ["documents:read"] },
      "documents:read",
      signal(),
    ),
    /consent_required/,
  );
  for (const info of [
    { sub: "leo", groups: ["users"] },
    { sub: "other", groups: ["admins"] },
    { sub: "leo" },
  ]) {
    userinfo = info;
    await assert.rejects(access.require(auth(), "documents:read", signal()));
  }
  userinfo = { sub: "leo", groups: ["admins"] };
  await access.require(auth(), "documents:read", signal());
  userinfo = { sub: "leo", groups: [] };
  await assert.rejects(
    access.require(auth(), "documents:read", signal()),
    /forbidden/,
  );
});
test("UserInfo failures deny document access without exposing tokens", async () => {
  for (const request of [
    async () => new Response(null, { status: 401 }),
    async () => {
      throw new Error("secret");
    },
  ]) {
    const access = new DocumentAccess(
      "https://auth.example.test",
      "admins",
      request,
    );
    await assert.rejects(
      access.require(auth(), "documents:read", signal()),
      /documents_membership_unavailable/,
    );
  }
});
test("document searches bound excerpts and pagination, encode filters, and never follow backend links", async () => {
  const f = fixture();
  try {
    const result = await f.service.search(
      documentSearchSchema.parse({
        query: "Waschmaschine Rechnung",
        createdAfter: "2025-01-01",
        tagIds: [1],
      }),
      signal(),
    );
    assert.equal(result.documents[0].excerpt, "Machine bought");
    assert.equal(
      result.documents[0].link,
      "https://documents.example.test/documents/42/details",
    );
    assert.equal(result.nextPage, null);
    assert.equal(
      f.calls[0].url.searchParams.get("query"),
      "Waschmaschine Rechnung",
    );
    assert.equal(
      f.calls[0].url.searchParams.get("created__date__gte"),
      "2025-01-01",
    );
    const details = await f.service.details(
      documentDetailsSchema.parse({ documentId: 42, limit: 7 }),
      signal(),
    );
    assert.equal(details.text, "Machine");
    assert.equal(details.nextOffset, 7);
    assert.equal(details.content, "untrusted_document_text");
  } finally {
    f.cleanup();
  }
});
test("staged uploads belong to their caller and validate actual file bytes", async () => {
  const f = fixture();
  try {
    assert.throws(
      () => f.service.stage("leo", "fake.pdf", Buffer.from("not a pdf")),
      /unsupported_document_type/,
    );
    assert.equal(documentMime(pdf), "application/pdf");
    const { attachmentId } = f.service.stage("leo", "../../invoice.pdf", pdf);
    await assert.rejects(
      f.service.ingest("other", { attachmentId }, signal()),
      /forbidden/,
    );
    assert.equal(f.calls.length, 0);
    const result = await f.service.ingest("leo", { attachmentId }, signal());
    const form = f.calls[0].init?.body as FormData;
    assert.equal((form.get("document") as File).type, "application/pdf");
    assert(!(form.get("document") as File).name.includes("/"));
    assert.equal(result.outcome, "submitted");
    await assert.rejects(
      f.service.status("other", result.ingestionId, signal()),
      /forbidden/,
    );
    assert.equal(
      (await f.service.status("leo", result.ingestionId, signal())).outcome,
      "filed",
    );
  } finally {
    f.cleanup();
  }
});
test("concurrent and repeated content uploads reuse one durable receipt across restarts", async () => {
  const f = fixture();
  try {
    const a = f.service.stage("leo", "one.pdf", pdf),
      b = f.service.stage("leo", "two.pdf", pdf);
    const [first, second] = await Promise.all([
      f.service.ingest("leo", { attachmentId: a.attachmentId }, signal()),
      f.service.ingest("leo", { attachmentId: b.attachmentId }, signal()),
    ]);
    assert.equal(first.ingestionId, second.ingestionId);
    const restarted = new DocumentService(f.config, f.backend);
    assert.deepEqual(
      await restarted.ingest("leo", { attachmentId: a.attachmentId }, signal()),
      first,
    );
    assert.equal(f.calls.filter((c) => c.init?.method === "POST").length, 1);
  } finally {
    f.cleanup();
  }
});
test("uncertain Paperless writes never replay, even with a newly staged copy after restart", async () => {
  let writes = 0;
  const f = fixture(async () => {
    writes++;
    throw new Error("connection reset after submit");
  });
  try {
    const a = f.service.stage("leo", "invoice.pdf", pdf);
    const first = await f.service.ingest(
      "leo",
      { attachmentId: a.attachmentId },
      signal(),
    );
    assert.equal(first.outcome, "unconfirmed");
    const restarted = new DocumentService(f.config, f.backend);
    const b = restarted.stage("leo", "copy.pdf", pdf);
    assert.equal(
      (
        await restarted.ingest(
          "leo",
          { attachmentId: b.attachmentId },
          signal(),
        )
      ).ingestionId,
      first.ingestionId,
    );
    assert.equal(
      (await restarted.status("leo", first.ingestionId, signal())).outcome,
      "unconfirmed",
    );
    assert.equal(writes, 1);
  } finally {
    f.cleanup();
  }
});
test("task status handles pending, duplicate, failure, missing and paginated results", async () => {
  let status: unknown = [];
  const f = fixture(async (input) =>
    String(input).includes("post_document")
      ? Response.json(taskId)
      : Response.json(status),
  );
  try {
    const result = await f.service.ingest(
      "leo",
      { attachmentId: f.service.stage("leo", "a.pdf", pdf).attachmentId },
      signal(),
    );
    for (const [task, outcome] of [
      [{ status: "STARTED" }, "processing"],
      [{ status: "FAILURE", result: "duplicate document" }, "duplicate"],
      [{ status: "FAILURE", result: "OCR failed" }, "failed"],
      [{ status: "SUCCESS" }, "unconfirmed"],
    ] as const) {
      status = { results: [{ task_id: taskId, ...task }] };
      assert.equal(
        (await f.service.status("leo", result.ingestionId, signal())).outcome,
        outcome,
      );
    }
    status = [];
    assert.equal(
      (await f.service.status("leo", result.ingestionId, signal())).outcome,
      "unconfirmed",
    );
  } finally {
    f.cleanup();
  }
});

test("expired staging and orphan bytes are pruned while receipts survive", async () => {
  const f = fixture();
  try {
    const { attachmentId } = f.service.stage("leo", "invoice.pdf", pdf);
    const receipt = await f.service.ingest("leo", { attachmentId }, signal());
    const metadata = join(f.config.stateDir, `${attachmentId}.attachment`);
    const record = JSON.parse(readFileSync(metadata, "utf8"));
    record.expiresAt = 0;
    writeFileSync(metadata, JSON.stringify(record));
    const orphan = "c8ad6524-913f-4adc-91b2-629e01c763ae";
    const path = join(f.config.stateDir, `${orphan}.bytes`);
    writeFileSync(path, pdf);
    assert.equal(f.service.prune(), pdf.length);
    assert(!existsSync(metadata));
    utimesSync(path, new Date(0), new Date(0));
    assert.equal(f.service.prune(), 0);
    assert(!existsSync(path));
    assert.equal(
      (await f.service.status("leo", receipt.ingestionId, signal())).outcome,
      "filed",
    );
  } finally {
    f.cleanup();
  }
});
