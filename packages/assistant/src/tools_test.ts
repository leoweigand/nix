import assert from "node:assert/strict";
import { test } from "node:test";
import { availableTools, recordWrite, HomeWriteGuard } from "./tools.ts";
const token = (scope: string) =>
  `e30.${Buffer.from(JSON.stringify({ scope })).toString("base64url")}.fixture`;
test("tool presentation follows granted capabilities", () => {
  assert.deepEqual(availableTools(), []);
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
test("all write tools require a durable receipt and persistence failure blocks submission", () => {
  for (const tool of [
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
