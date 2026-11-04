import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Control, identity } from "./control.ts";
import { createControlServer, createFrontend, listenFrontend } from "./http.ts";
test("Unix ingress requires identity and same-origin writes; the control API authenticates ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "now-http-"));
  const control = new Control({
    database: join(directory, "registry.sqlite"),
    scratch: directory,
    domain: "now.test",
    runtimeUrl: "http://127.0.0.1:1",
    runtimeToken: "fixture",
  });
  const owner = identity("https://id.test", "alice");
  const created = await control.operation(owner, "create", {
    key: "create-fixture",
    description: "HTTP fixture.",
  });
  const frontend = createFrontend(control, "https://id.test");
  const socket = join(directory, "app.sock");
  await listenFrontend(frontend, socket);
  const api = createControlServer(
    control,
    "fixture-secret",
    "https://id.test",
    "runtime-secret",
  );
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/v1/get`;
  async function ingress(headers: Record<string, string>, method = "GET") {
    return new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          socketPath: socket,
          path: "/api",
          method,
          headers: { host: `${created.app.slug}.now.test`, ...headers },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        },
      );
      req.on("error", reject);
      req.end();
    });
  }
  try {
    assert.equal((await stat(socket)).mode & 0o777, 0o660);
    for (const token of ["", "fixture-secret"]) {
      const denied = await fetch(url.replace("/v1/get", "/internal/egress"), {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      });
      assert.equal(denied.status, 401);
    }
    const invalid = await fetch(url.replace("/v1/get", "/internal/egress"), {
      method: "POST",
      headers: { authorization: "Bearer runtime-secret" },
      body: "{}",
    });
    assert.equal(invalid.status, 400);

    assert.equal(await ingress({}), 401);
    assert.equal(
      await ingress(
        { "X-Now-Subject": "alice", origin: "https://other.now.test" },
        "POST",
      ),
      403,
    );
    assert.equal(
      await ingress(
        {
          "X-Now-Subject": "alice",
          origin: `https://${created.app.slug}.now.test`,
        },
        "POST",
      ),
      503,
    );
    const request = (headers: Record<string, string>, payload: unknown) =>
      fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    assert.equal(
      (await request({ "X-Now-Subject": "alice" }, { appId: created.app.id }))
        .status,
      401,
    );
    assert.equal(
      (
        await request(
          { authorization: "Bearer fixture-secret", "X-Now-Subject": "bob" },
          { appId: created.app.id, subject: "alice" },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await request(
          { authorization: "Bearer fixture-secret", "X-Now-Subject": "alice" },
          { appId: created.app.id },
        )
      ).status,
      200,
    );
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => frontend.close(() => resolve())),
      new Promise<void>((resolve) => api.close(() => resolve())),
    ]);
    control.db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
