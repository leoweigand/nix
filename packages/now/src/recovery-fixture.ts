// Invoked by the Linux runtime check between operator-controlled stops/restores.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Control, identity } from "./control.ts";
const directory = process.env.NOW_RECOVERY_DIR!;
const control = new Control({
  database: `${directory}/registry.sqlite`,
  scratch: `${directory}/builds`,
  domain: "now.test",
  runtimeUrl: process.env.NOW_TEST_RUNTIME_URL!,
  runtimeToken: process.env.NOW_TEST_RUNTIME_TOKEN!,
  compileSandbox: process.env.NOW_TEST_COMPILE_SANDBOX,
});
const owner = identity("https://id.test", "alice");
const call = (action: string, input: Record<string, unknown>) =>
  control.operation(owner, action, { key: randomUUID(), ...input });
try {
  if (process.argv[2] === "seed") {
    const app = (
      await call("create", {
        displayName: "Test App",
        description: "Recovery acceptance counter.",
      })
    ).app;
    const source = `import {DurableObject} from 'cloudflare:workers';export class App extends DurableObject {async fetch(r){if(r.method==='POST')this.ctx.storage.kv.put('saved',await r.text());return Response.json({saved:this.ctx.storage.kv.get('saved')??null});}}`;
    const revision = await call("put_source", {
      appId: app.id,
      baseRevision: null,
      files: { "src/app.ts": source },
      dependencies: {},
    });
    const build = await call("build", {
      appId: app.id,
      revision: revision.revision,
    });
    await Promise.all(control.jobs);
    assert.equal(
      (await call("get_build", { appId: app.id, releaseId: build.releaseId }))
        .release.state,
      "ready",
    );
    assert.ok(
      (
        await call("deploy", {
          appId: app.id,
          releaseId: build.releaseId,
          expectedRelease: null,
        })
      ).app,
    );
    const result = await call("request", {
      appId: app.id,
      path: "/api",
      method: "POST",
      body: "saved-before-restart",
    });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).saved, "saved-before-restart");
    await writeFile(
      `${directory}/acceptance.json`,
      JSON.stringify({
        appId: app.id,
        releaseId: build.releaseId,
        revision: revision.revision,
      }),
    );
  } else {
    const saved = JSON.parse(
      await readFile(`${directory}/acceptance.json`, "utf8"),
    );
    const current = await call("get", { appId: saved.appId });
    assert.equal(current.app.active, saved.releaseId);
    assert.equal(current.app.head, saved.revision);
    assert.ok(current.source.files["src/app.ts"]);
    const result = await call("request", {
      appId: saved.appId,
      path: "/api",
      method: "GET",
    });
    assert.equal(result.status, 200, result.body);
    assert.equal(JSON.parse(result.body).saved, "saved-before-restart");
    if (process.argv[2] === "destroy")
      assert.equal(
        (await call("destroy", { appId: saved.appId })).state,
        "destroyed",
      );
  }
} finally {
  await Promise.all(control.jobs);
  control.db.close();
}
