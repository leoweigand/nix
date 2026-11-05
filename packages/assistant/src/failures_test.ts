import { test } from "node:test";
import assert from "node:assert/strict";
import { operationState, failureReply } from "./failures.ts";
import { recordWrite } from "./tools.ts";

test("confirmed deployments and uncertain operations produce different, relevant recovery messages", () => {
  const deployed = {
    callId: "deploy",
    tool: "mcp__leolab__now_deploy",
    input: {},
    result: {
      app: {
        active: "release",
        displayName: "Test App",
        url: "https://test.now.example/",
      },
    },
  };
  const known = operationState({
    entries: [
      deployed,
      {
        callId: "check",
        tool: "mcp__leolab__now_request",
        input: { method: "GET" },
        result: { status: 200 },
      },
    ],
  });
  assert.equal(known.state, "recorded");
  assert.match(failureReply(known), /Test App was deployed/);
  assert.doesNotMatch(
    failureReply(known),
    /uncertain|document|bookmark|library/,
  );
  const pending = operationState({
    entries: [
      deployed,
      { callId: "edit", tool: "mcp__leolab__now_put_source", input: {} },
    ],
  });
  assert.equal(pending.state, "uncertain");
  assert.match(failureReply(pending), /app change/);
  assert.match(failureReply(pending), /won't repeat/);
  assert.doesNotMatch(failureReply(pending), /was deployed|document|bookmark/);
  assert.equal(
    operationState({
      entries: [{ ...deployed, result: { outcome: "uncertain" } }],
    }).state,
    "uncertain",
  );
  assert.equal(
    operationState({
      entries: [{ ...deployed, result: { outcome: "error", status: 500 } }],
    }).state,
    "uncertain",
  );
  assert.equal(
    operationState({
      entries: [
        {
          callId: "home",
          tool: "mcp__leolab__control_home_entities",
          input: {},
          result: { outcome: "confirmed", results: [{ outcome: "confirmed" }] },
        },
      ],
    }).state,
    "recorded",
  );
  assert.equal(
    operationState({
      entries: [
        {
          callId: "home",
          tool: "mcp__leolab__control_home_entities",
          input: {},
          result: {
            outcome: "partial_failure",
            results: [{ outcome: "unconfirmed" }],
          },
        },
      ],
    }).state,
    "uncertain",
  );
  assert.equal(
    operationState({
      entries: [
        deployed,
        {
          callId: "delete",
          tool: "mcp__leolab__now_destroy",
          input: {},
          result: { outcome: "destroyed" },
        },
      ],
    }).app,
    undefined,
  );
  let attempts = 0;
  recordWrite("mcp__leolab__now_request", { method: "GET" }, () => attempts++);
  recordWrite("mcp__leolab__now_request", { method: "HEAD" }, () => attempts++);
  assert.equal(attempts, 0);
  recordWrite("mcp__leolab__now_request", { method: "POST" }, () => attempts++);
  assert.equal(attempts, 1);
});
