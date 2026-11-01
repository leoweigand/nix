import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BookmarkService,
  bookmarkSaveSchema,
  bookmarkSearchSchema,
} from "./bookmarks.ts";
const signal = AbortSignal.timeout(10000);
export const bookmarkFixture = (id: number) => ({
  id,
  url: `https://example.com/${id}`,
  title: `Article ${id}`,
  description: "Description",
  notes: "Personal note",
  tag_names: ["existing"],
  is_archived: false,
  unread: false,
  shared: false,
  date_added: "2026-11-01",
  date_modified: "2026-11-01",
});
const alice = "a".repeat(40),
  bob = "b".repeat(40);
function fixture() {
  const records = new Map([
    [alice, bookmarkFixture(1)],
    [bob, bookmarkFixture(2)],
  ]);
  const calls: Array<{
    token: string;
    url: URL;
    method: string;
    body?: Record<string, unknown>;
  }> = [];
  const service = new BookmarkService(
    {
      url: "http://127.0.0.1:9094",
      ownerSubject: "alice",
      token: alice,
    },
    async (input, init) => {
      const url = new URL(String(input));
      const token = String(
        (init?.headers as Record<string, string>).Authorization,
      ).slice(6);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ token, url, method, body });
      assert.equal(init?.redirect, "error");
      assert.equal(url.origin, "http://127.0.0.1:9094");
      const own = records.get(token)!;
      if (url.pathname.endsWith("/check/"))
        return Response.json({ bookmark: own });
      if (
        url.pathname === "/api/bookmarks/" ||
        url.pathname === "/api/bookmarks/archived/"
      )
        return Response.json({
          count: 1,
          results: [own],
          next: "https://evil.test/?token=leak",
        });
      if (url.pathname === `/api/bookmarks/${own.id}/`) {
        if (body) Object.assign(own, body);
        return Response.json(own);
      }
      return new Response(null, { status: 404 });
    },
  );
  return { service, calls, records };
}
test("only the configured owner may use the global token, before any backend request", async () => {
  const { service, calls, records } = fixture();
  const result = await service.search(
    "alice",
    bookmarkSearchSchema.parse({}),
    signal,
  );
  assert.equal(result.bookmarks[0].bookmarkId, 1);
  assert.equal(result.nextOffset, null);
  assert.equal(
    (await service.details("alice", 1, signal)).bookmark.bookmarkId,
    1,
  );
  await assert.rejects(
    service.details("alice", 2, signal),
    /bookmark_not_found/,
  );
  await service.save(
    "alice",
    bookmarkSaveSchema.parse({
      url: "https://example.com/1",
      tags: ["new"],
      note: "Added note",
    }),
    signal,
  );
  assert.deepEqual(records.get(alice)?.tag_names, ["existing", "new"]);
  assert.equal(records.get(alice)?.notes, "Personal note\n\nAdded note");
  const count = calls.length;
  for (const subject of [undefined, "bob", "unknown", "__proto__"]) {
    await assert.rejects(
      service.search(subject, bookmarkSearchSchema.parse({}), signal),
      /bookmarks_forbidden/,
    );
    await assert.rejects(
      service.details(subject, 1, signal),
      /bookmarks_forbidden/,
    );
    await assert.rejects(
      service.save(
        subject,
        bookmarkSaveSchema.parse({ url: "https://example.com" }),
        signal,
      ),
      /bookmarks_forbidden/,
    );
  }
  assert.equal(calls.length, count);
  assert(calls.every((c) => c.token === alice));
});
test("duplicate saves preserve metadata and sharing, append a note only once", async () => {
  const { service, calls } = fixture();
  const input = bookmarkSaveSchema.parse({
    url: "https://example.com/1",
    tags: ["new"],
    note: "Added note",
  });
  const first = await service.save("alice", input, signal);
  const second = await service.save("alice", input, signal);
  assert.equal(first.outcome, "updated");
  assert.equal(second.outcome, "already_saved");
  assert.equal(calls.filter((c) => c.method === "PATCH").length, 1);
  assert.equal(first.bookmark.description, "Description");
  assert(!JSON.stringify(first).includes(alice));
});
test("new saves are private and uncertain writes are never retried", async () => {
  let writes = 0;
  const service = new BookmarkService(
    {
      url: "http://127.0.0.1:9094",
      ownerSubject: "alice",
      token: alice,
    },
    async (_input, init) => {
      if (init?.method === "GET") return Response.json({ bookmark: null });
      writes++;
      assert.equal(JSON.parse(String(init?.body)).shared, false);
      throw new Error("connection lost after submission");
    },
  );
  await assert.rejects(
    service.save(
      "alice",
      bookmarkSaveSchema.parse({ url: "https://example.com" }),
      signal,
    ),
    /bookmark_write_unconfirmed/,
  );
  assert.equal(writes, 1);
});
test("rejects missing owner, invalid token and caller-selected identities", () => {
  for (const config of [
    { ownerSubject: "", token: alice },
    { ownerSubject: "alice", token: "" },
  ])
    assert.throws(
      () => new BookmarkService({ url: "http://localhost", ...config }),
      /invalid_bookmark_configuration/,
    );
  assert.throws(() => bookmarkSearchSchema.parse({ subject: "bob" }));
  for (const url of [
    "file:///etc/passwd",
    "https://user:secret@example.com",
    "javascript:alert(1)",
  ])
    assert.throws(() => bookmarkSaveSchema.parse({ url }));
});
