import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { permissions } from "./permissions.ts";
import { validateSource } from "./builder.ts";
import { Control, identity } from "./control.ts";
import { fetchInference } from "./inference.ts";

const origin = "https://inference.internal.leolab.party";
const files = { "src/app.ts": "export class App {}" };
const manifest = (inference: boolean) =>
  JSON.stringify({ permissions: { inference } });
const request = {
  url: `${origin}/v1/chat/completions`,
  method: "POST",
  headers: {
    authorization: "Bearer app-secret",
    cookie: "private",
    "x-now-user-id": "forged",
  },
  body: Buffer.from(
    JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
  ).toString("base64"),
};

test("now.json permissions fail closed and are accepted as source", () => {
  assert.equal(permissions(files).inference, false);
  validateSource({
    files: { ...files, "now.json": manifest(true) },
    dependencies: {},
  });
  assert.equal(permissions({ "now.json": manifest(true) }).inference, true);
  for (const value of [
    "null",
    "[]",
    "{}",
    "{",
    '{"permissions":{"inference":"true"}}',
    '{"permissions":{"infernece":true}}',
    '{"permissions":true}',
    '{"permission":{"inference":true}}',
  ])
    assert.throws(() => permissions({ "now.json": value }), /now.json/);
});

test("inference uses the serving revision, survives restart and follows revocation and rollback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "now-inference-"));
  let calls = 0;
  const gateway = createServer(async (req, res) => {
    calls++;
    assert.equal(req.url, "/v1/chat/completions");
    for (const name of ["authorization", "cookie", "x-now-user-id"])
      assert.equal(req.headers[name], undefined);
    let body = "";
    for await (const chunk of req) body += chunk;
    assert.deepEqual(JSON.parse(body), {
      messages: [{ role: "user", content: "Hello" }],
    });
    res.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "1",
      "set-cookie": "secret",
    });
    res.end('{"error":"capacity"}');
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  assert.ok(address && typeof address !== "string");
  const backend = `http://127.0.0.1:${address.port}`;
  const config = {
    database: join(directory, "registry.sqlite"),
    scratch: directory,
    domain: "now.test",
    runtimeUrl: "http://127.0.0.1:1",
    runtimeToken: "fixture",
    inferenceUrl: backend,
  };
  let control = new Control(config);
  try {
    const owner = identity("https://id.test", "alice");
    const { app } = await control.execute(owner, "create", {
      displayName: "Test App",
      description: "Inference fixture",
    });
    const root = `${app.id}:user`;
    control.run("INSERT INTO roots VALUES(?,?)", app.id, root);
    async function revision(enabled?: boolean) {
      const result = await control.execute(owner, "put_source", {
        appId: app.id,
        baseRevision: control.app(app.id).head,
        files: {
          ...files,
          ...(enabled === undefined ? {} : { "now.json": manifest(enabled) }),
        },
        dependencies: {},
        // An origin declaration alone must never grant inference.
        network: { server: [origin] },
      });
      control.run(
        "INSERT INTO releases VALUES(?,?,?,'ready',?,NULL,NULL)",
        result.revision,
        app.id,
        result.revision,
        "code",
      );
      return result.revision;
    }
    const denied = await revision();
    control.run("UPDATE apps SET active=? WHERE id=?", denied, app.id);
    const outbound = (release: string) => ({ ...request, root, release });
    await assert.rejects(
      control.egress(outbound(denied)),
      /permissions.inference/,
    );
    const allowed = await revision(true);
    // A head revision does not grant access before deployment.
    await assert.rejects(
      control.egress(outbound(denied)),
      /permissions.inference/,
    );
    control.run("UPDATE apps SET active=? WHERE id=?", allowed, app.id);
    control.db.close();
    control = new Control(config);
    const response = await control.egress(outbound(allowed));
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(await response.json(), { error: "capacity" });
    await control.execute(owner, "put_source", {
      appId: app.id,
      baseRevision: allowed,
      replace: false,
      files: { "public/index.html": "Hello" },
    });
    assert.equal(
      permissions(
        (await control.execute(owner, "get", { appId: app.id })).source.files,
      ).inference,
      true,
    );
    const revoked = await revision(false);
    control.run("UPDATE apps SET active=? WHERE id=?", revoked, app.id);
    await assert.rejects(
      control.egress(outbound(revoked)),
      /permissions.inference/,
    );
    await assert.rejects(control.egress(outbound(allowed)), /no longer active/);
    control.run("UPDATE apps SET active=? WHERE id=?", allowed, app.id);
    assert.equal((await control.egress(outbound(allowed))).status, 429);
    for (const path of [
      "/healthz",
      "/v1/models?x=1",
      "/v1/chat/completions#x",
      "/v1/unknown",
    ])
      await assert.rejects(
        control.egress({ ...outbound(allowed), url: origin + path }),
        /Unsupported inference/,
      );
    await assert.rejects(
      control.egress({
        ...outbound(allowed),
        body: Buffer.from('{"stream":true}').toString("base64"),
      }),
      /stream:false/,
    );
    assert.equal(calls, 2);
    control.config.inferenceUrl = undefined;
    await assert.rejects(control.egress(outbound(allowed)), /unavailable/);
  } finally {
    control.db.close();
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("inference restricts routes, bodies, redirects and response size", async () => {
  let mode = "models";
  const gateway = createServer((req, res) => {
    if (mode === "redirect") {
      res.writeHead(302, { location: "/unexpected" });
      res.end();
    } else if (mode === "large") res.end(Buffer.alloc(2 * 1024 * 1024 + 1));
    else {
      assert.equal(req.url, "/v1/models");
      res.end('{"data":[]}');
    }
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  assert.ok(address && typeof address !== "string");
  const backend = `http://127.0.0.1:${address.port}`;
  try {
    assert.deepEqual(
      await (
        await fetchInference(
          { ...request, url: origin + "/v1/models", method: "GET", body: "" },
          backend,
        )
      ).json(),
      { data: [] },
    );
    await assert.rejects(
      fetchInference(
        { ...request, body: Buffer.alloc(1024 * 1024 + 1).toString("base64") },
        backend,
      ),
      /exceeds/,
    );
    await assert.rejects(
      fetchInference(
        { ...request, body: Buffer.from("[]").toString("base64") },
        backend,
      ),
      /JSON object/,
    );
    mode = "redirect";
    await assert.rejects(fetchInference(request, backend));
    mode = "large";
    await assert.rejects(fetchInference(request, backend), /exceeds 2 MiB/);
  } finally {
    await new Promise<void>((resolve) => gateway.close(() => resolve()));
  }
});
