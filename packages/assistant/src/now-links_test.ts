import { test } from "node:test";
import assert from "node:assert/strict";
import { verifiedNowApps, withNowLaunchButtons } from "./now-links.ts";

test("launch buttons use verified live app metadata, match reply links and avoid duplicates", () => {
  const app = {
    id: "fixture",
    displayName: "Test App",
    state: "live",
    active: "release",
    url: "https://fixture.now.example",
  };
  const metadata = verifiedNowApps({
    entries: [
      {
        callId: "create",
        tool: "mcp__leolab__now_create",
        input: {},
        result: { app: { ...app, active: null } },
      },
      {
        callId: "deploy",
        tool: "mcp__leolab__now_deploy",
        input: {},
        result: { app },
      },
      {
        callId: "untrusted",
        tool: "mcp__leolab__now_request",
        input: {},
        result: { app: { ...app, id: "forged", url: "https://evil.example" } },
      },
    ],
  });
  assert.equal(metadata.length, 1);
  const text = `Your app is live at [${app.url}](${app.url}/).`;
  assert.deepEqual(withNowLaunchButtons(text, metadata), [
    { label: "Open app", url: app.url },
  ]);
  assert.deepEqual(
    withNowLaunchButtons(text, metadata, [
      { label: "Launch", url: app.url + "/" },
    ]),
    [{ label: "Launch", url: app.url + "/" }],
  );
  for (const other of [
    "No app link",
    "https://fixture.now.example.evil.test",
    "https://evil.example",
  ])
    assert.deepEqual(withNowLaunchButtons(other, metadata), []);
  assert.equal(
    verifiedNowApps({
      entries: [
        {
          callId: "draft",
          tool: "mcp__leolab__now_create",
          input: {},
          result: { app: { ...app, active: null } },
        },
      ],
    }).length,
    0,
  );
  assert.equal(
    verifiedNowApps({
      entries: [
        {
          callId: "list",
          tool: "mcp__leolab__now_list",
          input: {},
          result: { apps: [app] },
        },
        {
          callId: "destroy",
          tool: "mcp__leolab__now_destroy",
          input: { appId: app.id },
          result: { outcome: "destroyed" },
        },
      ],
    }).length,
    0,
  );
});
