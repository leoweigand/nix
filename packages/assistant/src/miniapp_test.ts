import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MiniApp } from "./miniapp.ts";

test("Telegram launcher establishes only the linked user's genuine Pocket ID session", async () => {
  const directory = mkdtempSync(join(tmpdir(), "now-launch-"));
  const now = 1800000000000;
  let linked = true,
    disabled = false,
    allowed = true;
  const calls: string[] = [];
  const options = {
    issuer: "https://auth.lab.test",
    libraryUrl: "https://now.lab.test/",
    loginUrl: "https://login.lab.test",
    botToken: "123:fixture",
    apiKey: "admin-fixture",
    ownerId: "123",
    subject: "pocket-alice",
    allowedGroups: ["admins"],
    stateDir: directory,
    now: () => now,
    connections: {
      token: async () =>
        linked
          ? `e30.${Buffer.from(JSON.stringify({ scope: "now:read" })).toString("base64url")}.fixture`
          : undefined,
    },
    fetch: (async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      assert.equal(
        new Headers(init?.headers).get("x-api-key"),
        "admin-fixture",
      );
      if (path.endsWith("/groups"))
        return Response.json(allowed ? [{ name: "admins" }] : []);
      if (path.endsWith("/users/pocket-alice"))
        return Response.json({ id: "pocket-alice", disabled });
      if (path.endsWith("/users/pocket-alice/one-time-access-token")) {
        assert.equal(init?.method, "POST");
        assert.deepEqual(JSON.parse(String(init?.body)), { ttl: "60s" });
        return Response.json({ token: "ABC123" }, { status: 201 });
      }
      assert.equal(path, "/api/one-time-access-token/ABC123");
      const headers = new Headers();
      headers.append(
        "set-cookie",
        "access_token=pocket-session; Path=/; Secure; HttpOnly; SameSite=Lax",
      );
      headers.append(
        "set-cookie",
        "known_browser=fixture; Path=/; Secure; HttpOnly",
      );
      return Response.json({ id: "pocket-alice" }, { headers });
    }) as typeof fetch,
  };
  const launch = new MiniApp(options);
  let sequence = 0;
  const signed = (extra: Record<string, string> = {}) => {
    const data = new URLSearchParams({
      auth_date: String(now / 1000),
      query_id: `launch-${++sequence}`,
      user: JSON.stringify({ id: 123 }),
      ...extra,
    });
    const secret = createHmac("sha256", "WebAppData")
      .update(options.botToken)
      .digest();
    const check = [...data.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    data.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
    return data.toString();
  };
  const open = async () => {
    const response = await launch.handle(
      new Request("https://auth.lab.test/now/telegram"),
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /telegram-web-app.js/);
    return response.headers.getSetCookie()[0].split(";")[0];
  };
  const post = (
    data: string,
    cookie: string,
    app: unknown = "violet-iris",
    origin = options.issuer,
  ) =>
    launch.handle(
      new Request("https://auth.lab.test/now/telegram", {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({ initData: data, app }),
      }),
    );
  try {
    const cookie = await open();
    for (const [data, origin, app] of [
      [signed(), "https://evil.test", "violet-iris"],
      [signed({ user: '{"id":999}' }), options.issuer, "violet-iris"],
      [
        signed({ auth_date: String(now / 1000 - 301) }),
        options.issuer,
        "violet-iris",
      ],
      [
        signed({ auth_date: String(now / 1000 + 31) }),
        options.issuer,
        "violet-iris",
      ],
      [signed() + "&user=%7B%7D", options.issuer, "violet-iris"],
      [signed().replace("launch-", "tampered-"), options.issuer, "violet-iris"],
      [signed(), options.issuer, "https://evil.test"],
    ])
      assert.equal((await post(data, cookie, app, origin)).status, 403);
    assert.equal(calls.length, 0);
    assert.equal((await post(signed(), "")).status, 403);
    linked = false;
    assert.equal((await post(signed(), cookie)).status, 403);
    assert.equal(calls.length, 0);
    linked = true;
    disabled = true;
    assert.equal((await post(signed(), cookie)).status, 403);
    disabled = false;
    allowed = false;
    assert.equal((await post(signed(), cookie)).status, 403);
    assert.ok(!calls.some((p) => p.includes("one-time-access-token")));
    allowed = true;
    const proof = signed();
    const response = await post(proof, cookie);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(
      new URL(result.redirect).searchParams.get("rd"),
      "https://violet-iris.now.lab.test/",
    );
    assert.equal(response.headers.getSetCookie().length, 3);
    assert.ok(
      response.headers
        .getSetCookie()
        .some((c) => c.startsWith("access_token=pocket-session;")),
    );
    assert.ok(!JSON.stringify(result).includes("ABC123"));
    const usedCalls = calls.length;
    assert.equal((await post(proof, cookie)).status, 403);
    assert.ok(
      calls.slice(usedCalls).every((p) => !p.includes("one-time-access-token")),
    );
    const restarted = new MiniApp(options);
    const replay = await restarted.handle(
      new Request("https://auth.lab.test/now/telegram", {
        method: "POST",
        headers: { origin: options.issuer, cookie },
        body: JSON.stringify({ initData: proof }),
      }),
    );
    assert.equal(replay.status, 403);
    const library = await post(signed(), await open(), null);
    assert.equal(
      new URL((await library.json()).redirect).searchParams.get("rd"),
      options.libraryUrl,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
