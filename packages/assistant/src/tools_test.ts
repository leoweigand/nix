import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availableTools,
  recordWrite,
  HomeWriteGuard,
  BookmarkWriteGuard,
} from "./tools.ts";
const token = (scope: string) =>
  `e30.${Buffer.from(JSON.stringify({ scope })).toString("base64url")}.fixture`;
test("tool presentation follows granted capabilities", () => {
  assert.deepEqual(availableTools(), []);
  assert(
    availableTools(token("media:read")).includes(
      "mcp__leolab__get_download_progress",
    ),
  );
  assert(
    !availableTools(token("media:request")).includes(
      "mcp__leolab__get_download_progress",
    ),
  );
  assert.deepEqual(availableTools(token("home:read")), [
    "mcp__leolab__whoami",
    "mcp__leolab__search_home_entities",
    "mcp__leolab__get_home_entity",
  ]);
  assert(
    !availableTools(token("media:read")).includes(
      "mcp__leolab__control_home_entities",
    ),
  );
  assert(
    availableTools(token("home:control")).includes(
      "mcp__leolab__control_home_entities",
    ),
  );
});
test("Now tools are available in groups with the sender's scopes; personal documents and bookmarks stay private", () => {
  const granted = token("now:read now:write documents:read bookmarks:read");
  const shared = availableTools(granted, "shared");
  assert.ok(shared.includes("mcp__leolab__now_create"));
  assert.ok(shared.includes("mcp__leolab__now_get"));
  assert.ok(shared.includes("mcp__leolab__now_destroy"));
  assert.ok(!shared.includes("mcp__leolab__search_documents"));
  assert.ok(!shared.includes("mcp__leolab__search_bookmarks"));
  const readOnly = availableTools(token("now:read"), "shared");
  assert.ok(readOnly.includes("mcp__leolab__now_get"));
  assert.ok(!readOnly.includes("mcp__leolab__now_create"));
  assert.ok(
    !availableTools(token("media:read"), "shared").includes(
      "mcp__leolab__now_get",
    ),
  );
});
test("all write tools require a durable receipt and persistence failure blocks submission", () => {
  for (const tool of [
    "mcp__leolab__save_bookmark",
    "mcp__leolab__request_media",
    "mcp__leolab__control_home_entities",
  ])
    assert.throws(
      () =>
        recordWrite(
          tool,
          { entityIds: ["light.hall"], action: "turn_on" },
          () => {
            throw new Error("disk full");
          },
        ),
      /disk full/,
    );
  let saved: unknown;
  recordWrite(
    "mcp__leolab__control_home_entities",
    { entityIds: ["light.hall"], action: "turn_on", secret: "do not retain" },
    (v) => {
      saved = v;
    },
  );
  assert.deepEqual(saved, {
    tool: "mcp__leolab__control_home_entities",
    entityIds: ["light.hall"],
    action: "turn_on",
  });
  recordWrite("mcp__leolab__get_home_entity", {}, () => {
    throw new Error("read must not write receipt");
  });
});

test("uncertain home commands cannot be repeated in the same request", () => {
  const g = new HomeWriteGuard(),
    tool = "mcp__leolab__control_home_entities",
    input = { entityIds: ["light.hall"] };
  g.before(tool, input);
  g.after(tool, {
    results: [
      { entityId: "light.hall", outcome: "unconfirmed", submitted: null },
    ],
  });
  assert.throws(() => g.before(tool, input), /uncertain/);
  g.after(tool, {
    results: [
      { entityId: "light.hall", outcome: "confirmed", submitted: true },
    ],
  });
  g.before(tool, input);
});

test("personal bookmarks require their scopes and stay unavailable in groups", () => {
  const grant = token("bookmarks:read bookmarks:write");
  assert(availableTools(grant).includes("mcp__leolab__search_bookmarks"));
  assert(availableTools(grant).includes("mcp__leolab__save_bookmark"));
  assert.deepEqual(availableTools(grant, "shared"), ["mcp__leolab__whoami"]);
  assert(
    !availableTools(token("bookmarks:read")).includes(
      "mcp__leolab__save_bookmark",
    ),
  );
  let saved: unknown;
  recordWrite(
    "mcp__leolab__save_bookmark",
    { url: "https://example.com", note: "private note" },
    (value) => {
      saved = value;
    },
  );
  assert.deepEqual(saved, {
    tool: "mcp__leolab__save_bookmark",
    url: "https://example.com",
  });
});

test("an uncertain bookmark save cannot be replayed in the same model request", () => {
  const guard = new BookmarkWriteGuard();
  const tool = "mcp__leolab__save_bookmark",
    input = { url: "https://example.com" };
  guard.before(tool, input);
  guard.after(tool, { isError: true });
  assert.throws(() => guard.before(tool, input), /pending or uncertain/);
  guard.after(tool, { outcome: "saved", bookmark: input });
  guard.before(tool, input);
});
