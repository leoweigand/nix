import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Control, identity, userKey } from "./control.ts";

test(
  "actual celld isolates users/apps, denies egress, preserves data across releases and removes state",
  { skip: !process.env.NOW_TEST_RUNTIME_URL },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "now-runtime-"));
    const control = new Control({
      database: join(directory, "registry.sqlite"),
      scratch: directory,
      domain: "now.test",
      runtimeUrl: process.env.NOW_TEST_RUNTIME_URL!,
      runtimeToken: process.env.NOW_TEST_RUNTIME_TOKEN!,
      compileSandbox: process.env.NOW_TEST_COMPILE_SANDBOX,
    });
    const owner = identity("https://id.test", "alice"),
      other = identity("https://id.test", "bob");
    const ids: string[] = [];
    const call = (action: string, input: Record<string, unknown>) =>
      control.operation(owner, action, { key: randomUUID(), ...input });
    const code = (
      version: number,
    ) => `import {DurableObject} from "cloudflare:workers";
    export class App extends DurableObject { async fetch(r) {
      const p=new URL(r.url).pathname;
      if(p==='/egress'){try{await fetch('http://127.0.0.1:8333/');return new Response('unsafe');}catch{return new Response('denied');}}
      const n=this.ctx.storage.kv.get('n')??0;
      if(r.method==='POST')this.ctx.storage.kv.put('n',n+1);
      return Response.json({n,version:${version},user:r.headers.get('X-Now-User-ID')});
    }}`;
    async function publish(
      appId: string,
      version: number,
      expectedRelease: string | null,
    ) {
      const current = await call("get", { appId });
      const revision = await call("put_source", {
        appId,
        baseRevision: current.app.head,
        files: {
          "src/app.ts": code(version),
          "public/index.html": "<h1>Counter</h1>",
        },
        dependencies: {},
      });
      const build = await call("build", { appId, revision: revision.revision });
      await Promise.all(control.jobs);
      assert.equal(
        (await call("get_build", { appId, releaseId: build.releaseId })).release
          .state,
        "ready",
      );
      assert.ok(
        (
          await call("deploy", {
            appId,
            releaseId: build.releaseId,
            expectedRelease,
          })
        ).app,
      );
      return build.releaseId;
    }
    async function read(
      appId: string,
      who: string,
      method = "GET",
      path = "/api",
    ) {
      const a = control.app(appId);
      return control.serve(
        appId,
        who,
        new Request(`https://${a.slug}.now.test${path}`, {
          method,
          headers: { "X-Now-User-ID": "forged" },
        }),
      );
    }
    try {
      for (let i = 0; i < 2; i++)
        ids.push(
          (await call("create", { description: `Counter ${i}.` })).app.id,
        );
      const first = await publish(ids[0]!, 1, null);
      await publish(ids[1]!, 1, null);
      assert.equal((await (await read(ids[0]!, owner, "POST")).json()).n, 0);
      assert.deepEqual(await (await read(ids[0]!, owner)).json(), {
        n: 1,
        version: 1,
        user: userKey(owner),
      });
      assert.equal((await (await read(ids[0]!, other)).json()).n, 0);
      assert.equal((await (await read(ids[1]!, owner)).json()).n, 0);
      assert.equal(
        await (await read(ids[0]!, owner, "GET", "/egress")).text(),
        "denied",
      );
      const second = await publish(ids[0]!, 2, first);
      const cached = await call("request", {
        appId: ids[0],
        path: "/api",
        method: "GET",
      });
      assert.equal(cached.status, 200);
      assert.ok(
        control
          .all("SELECT result FROM receipts WHERE app=?", ids[0])
          .some((row) => row.result?.includes(userKey(owner))),
      );
      assert.equal((await (await read(ids[0]!, owner)).json()).n, 1);
      assert.equal(
        (
          await call("deploy", {
            appId: ids[0],
            releaseId: first,
            expectedRelease: first,
          })
        ).status,
        409,
      );
      await call("rollback", {
        appId: ids[0],
        releaseId: first,
        expectedRelease: second,
      });
      assert.deepEqual(await (await read(ids[0]!, owner)).json(), {
        n: 1,
        version: 1,
        user: userKey(owner),
      });
      // Idle eviction must reconstruct the dynamic class against the same database.
      if (process.env.NOW_TEST_IDLE_WAIT_MS)
        await new Promise((resolve) =>
          setTimeout(resolve, Number(process.env.NOW_TEST_IDLE_WAIT_MS)),
        );
      assert.equal((await (await read(ids[0]!, owner)).json()).n, 1);
      assert.equal(
        (await call("destroy", { appId: ids[0] })).state,
        "destroyed",
      );
      await assert.rejects(read(ids[0]!, owner), /destroyed/);
      assert.ok(
        control
          .all("SELECT result FROM receipts WHERE app=?", ids[0])
          .every((row) => !row.result?.includes(userKey(owner))),
      );
      const probe = await control.invoke({
        root: `${ids[0]}:${userKey(owner)}`,
        operation: "fetch",
        release: first,
        code: code(1),
        subject: userKey(owner),
        request: { url: "https://test/", method: "GET", headers: {} },
      });
      const probeBody = await probe.text();
      assert.equal(probe.status, 410, probeBody);
      assert.equal(
        probeBody,
        "App state retired",
        "Retired roots must never reopen deleted user data",
      );
      await control.invoke({
        root: `${ids[0]}:${userKey(owner)}`,
        operation: "destroy",
      });
      assert.equal((await (await read(ids[1]!, owner)).json()).n, 0);
    } finally {
      for (const appId of ids)
        if (control.app(appId).state !== "destroyed")
          await call("destroy", { appId });
      await Promise.all(control.jobs);
      control.db.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
