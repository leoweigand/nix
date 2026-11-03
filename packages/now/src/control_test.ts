import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Control, identity } from "./control.ts";
import { bundle } from "./builder.ts";

const owner = identity("https://id.example", "alice");
const stranger = identity("https://id.example", "bob");
const source = {
  files: {
    "src/app.ts":
      'import {DurableObject} from "cloudflare:workers"; export class App extends DurableObject {fetch(){return new Response("ok")}}',
  },
  dependencies: {},
};
test("ownership, retry receipts, stale edits and destroyed builds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "now-test-"));
  const control = new Control({
    database: join(directory, "registry.sqlite"),
    scratch: directory,
    domain: "now.example",
    runtimeUrl: "http://127.0.0.1:1",
    runtimeToken: "fixture",
  });
  try {
    const created = await control.operation(owner, "create", {
      key: "create-app-1",
      description: "Save named QR codes.",
    });
    assert.deepEqual(
      await control.operation(owner, "create", {
        key: "create-app-1",
        description: "Save named QR codes.",
      }),
      created,
    );
    await assert.rejects(
      control.operation(owner, "create", {
        key: "create-app-1",
        description: "Different",
      }),
      /different input/,
    );
    const id = created.app.id;
    await assert.rejects(
      control.operation(stranger, "get", { appId: id }),
      /not found/,
    );
    const revision = await control.operation(owner, "put_source", {
      key: "source-app-1",
      appId: id,
      baseRevision: null,
      ...source,
    });
    assert.ok(revision.revision);
    const edited = await control.operation(owner, "put_source", {
      key: "edit-app-source",
      appId: id,
      baseRevision: revision.revision,
      replace: false,
      files: { "public/index.html": "Hello" },
    });
    const afterEdit = await control.operation(owner, "get", { appId: id });
    assert.equal(
      afterEdit.source.files["src/app.ts"],
      source.files["src/app.ts"],
    );
    assert.equal(afterEdit.source.files["public/index.html"], "Hello");
    const removed = await control.operation(owner, "put_source", {
      key: "remove-app-file",
      appId: id,
      baseRevision: edited.revision,
      replace: false,
      files: { "public/index.html": null },
    });
    assert.ok(removed.revision);
    assert.equal(
      (await control.operation(owner, "get", { appId: id })).source.files[
        "public/index.html"
      ],
      undefined,
    );
    assert.equal(
      (
        await control.operation(owner, "put_source", {
          key: "source-app-2",
          appId: id,
          baseRevision: null,
          ...source,
        })
      ).status,
      409,
    );
    const build = await control.operation(owner, "build", {
      key: "build-app-1",
      appId: id,
      revision: revision.revision,
    });
    assert.equal(build.state, "building");
    assert.equal(
      (
        await control.operation(owner, "destroy", {
          key: "destroy-app-1",
          appId: id,
        })
      ).state,
      "destroyed",
    );
    await Promise.all(control.jobs);
    assert.equal(control.app(id).state, "destroyed");
    assert.equal(
      control.all("SELECT * FROM releases WHERE app=?", id).length,
      0,
    );
    assert.equal(
      control.all("SELECT * FROM revisions WHERE app=?", id).length,
      0,
    );
    assert.equal(
      (
        await control.operation(owner, "deploy", {
          key: "deploy-app-1",
          appId: id,
          releaseId: build.releaseId,
          expectedRelease: null,
        })
      ).status,
      410,
    );
  } finally {
    control.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
test("builder rejects host file imports and package URLs without executing code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "now-build-test-"));
  try {
    const secret = join(directory, "host-secret.txt");
    await writeFile(secret, "host-secret");
    const result = await bundle(source, directory);
    assert.match(result.code, /export/);
    const ignoredConfig = await bundle(
      {
        ...source,
        files: {
          ...source.files,
          "src/tsconfig.json": JSON.stringify({ extends: secret }),
        },
      },
      directory,
    );
    assert.match(ignoredConfig.code, /export/);
    await assert.rejects(
      bundle(
        {
          files: {
            "src/app.ts": `import secret from ${JSON.stringify(secret)}; console.log(secret);`,
          },
          dependencies: {},
        },
        directory,
      ),
      /Imports must stay inside/,
    );
    await assert.rejects(
      bundle(
        {
          files: {
            "src/app.ts": 'import "./nested.ts";',
            "src/nested.ts": `import secret from ${JSON.stringify(secret)}; console.log(secret);`,
          },
          dependencies: {},
        },
        directory,
      ),
      /Imports must stay inside/,
    );
    await assert.rejects(
      bundle({ ...source, dependencies: { stolen: "file:/etc" } }, directory),
      /exact semver/,
    );
    await assert.rejects(
      bundle(
        { ...source, files: { ...source.files, "src/../../bad.ts": "bad" } },
        directory,
      ),
      /Invalid source path/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("an interrupted receipt is reported as uncertain without repeating a write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "now-receipt-test-"));
  const config = {
    database: join(directory, "registry.sqlite"),
    scratch: directory,
    domain: "now.example",
    runtimeUrl: "http://127.0.0.1:1",
    runtimeToken: "fixture",
  };
  let control = new Control(config);
  try {
    const input = { key: "create-app-1", description: "Test." };
    await control.operation(owner, "create", input);
    control.run("UPDATE receipts SET state='pending'");
    control.db.close();
    control = new Control(config);
    assert.equal(
      (await control.operation(owner, "create", input)).outcome,
      "uncertain",
    );
    assert.equal(control.all("SELECT * FROM apps").length, 1);
  } finally {
    control.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
