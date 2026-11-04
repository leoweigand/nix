import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Control, identity } from "./control.ts";
import { library } from "./library.ts";

test("legacy apps gain editable display names without changing identity, releases or discovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "now-display-names-"));
  const database = join(directory, "registry.sqlite");
  const owner = identity("https://id.test", "alice");
  const legacy = new DatabaseSync(database);
  legacy.exec(
    "CREATE TABLE apps(id TEXT PRIMARY KEY,slug TEXT UNIQUE,owner TEXT,description TEXT,head TEXT,active TEXT,state TEXT)",
  );
  legacy
    .prepare("INSERT INTO apps VALUES(?,?,?,?,?,?,'live')")
    .run(
      "fixture-app",
      "velvet-lotus",
      owner,
      "A sarcastic forecast for Berlin.",
      "source-revision",
      "serving-release",
    );
  legacy.close();
  const config = {
    database,
    scratch: directory,
    domain: "now.test",
    runtimeUrl: "http://127.0.0.1:1",
    runtimeToken: "fixture",
  };
  let control = new Control(config);
  try {
    control.run(
      "INSERT INTO revisions VALUES(?,?,?)",
      "source-revision",
      "fixture-app",
      JSON.stringify({ files: {}, dependencies: {} }),
    );
    const before = (
      await control.operation(owner, "get", { appId: "fixture-app" })
    ).app;
    assert.equal(before.displayName, "Velvet Lotus");
    const input = {
      key: "rename-weather",
      appId: before.id,
      displayName: "  Berlin   Weather ",
      expectedDisplayName: before.displayName,
    };
    const result = await control.operation(owner, "rename", input);
    assert.equal(result.app.displayName, "Berlin Weather");
    for (const property of [
      "id",
      "slug",
      "url",
      "head",
      "active",
      "description",
    ])
      assert.equal(result.app[property], before[property]);
    assert.deepEqual(await control.operation(owner, "rename", input), result);
    assert.equal(
      (
        await control.operation(owner, "rename", {
          ...input,
          key: "stale-name",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await control.operation(identity("https://id.test", "bob"), "rename", {
          ...input,
          key: "wrong-owner",
        })
      ).status,
      404,
    );
    for (const [index, name] of [
      "",
      "One Two Three",
      "x".repeat(61),
    ].entries()) {
      assert.equal(
        (
          await control.operation(owner, "rename", {
            ...input,
            key: `invalid-name-${index}`,
            expectedDisplayName: "Berlin Weather",
            displayName: name,
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await control.operation(owner, "create", {
            key: `invalid-create-${index}`,
            displayName: name,
            description: "Fixture.",
          })
        ).status,
        400,
      );
    }
    for (const query of ["berlin weather", "sarcastic", "velvet-lotus"])
      assert.equal(
        (await control.operation(owner, "list", { query })).apps.length,
        1,
      );
    const html = library([result.app]);
    assert.match(html, /<span class="name">Berlin Weather<\/span>/);
    assert.ok(!html.includes(before.description));
    assert.equal(
      html.match(/<svg.*?<\/svg>/)?.[0],
      library([before]).match(/<svg.*?<\/svg>/)?.[0],
    );
    control.db.close();
    control = new Control(config);
    assert.equal(
      (await control.operation(owner, "list", {})).apps[0].displayName,
      "Berlin Weather",
    );
    const created = await control.operation(owner, "create", {
      key: "create-named-app",
      displayName: "AI Demo",
      description: "Test inference.",
    });
    assert.equal(created.app.displayName, "AI Demo");
  } finally {
    control.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
