import { test } from "node:test";
import assert from "node:assert/strict";
import { gatewaySession, embeddedCookie } from "./gateway-session.ts";

test("gateway exchange isolates credentials, verifies identity and rejects redirects outside the sign-in flow", async () => {
  let fault = "",
    calls = 0;
  const options = {
    issuer: "https://auth.lab.test",
    loginUrl: "https://login.lab.test",
    target: "https://violet-iris.now.lab.test/",
    subject: "alice",
    pocketCookies: ["access_token=pocket-session; Path=/; HttpOnly; Secure"],
    fetch: (async (input, init) => {
      calls++;
      const url = new URL(String(input));
      const cookie = new Headers(init?.headers).get("cookie")!;
      assert.equal(new Headers(init?.headers).get("x-api-key"), null);
      if (url.pathname === "/oauth2/start") {
        assert.equal(cookie, "");
        return new Response(null, {
          status: 302,
          headers: {
            location:
              fault === "external"
                ? "https://evil.test/steal"
                : fault === "wrong-path"
                  ? "https://auth.lab.test/api/users"
                  : "https://auth.lab.test/authorize",
            "set-cookie": "csrf=start; Secure; HttpOnly; SameSite=Lax",
          },
        });
      }
      if (url.pathname === "/authorize") {
        assert.equal(cookie, "access_token=pocket-session");
        if (fault === "consent")
          return new Response("Consent needed", { status: 200 });
        return new Response(null, {
          status: 303,
          headers: {
            location: "https://login.lab.test/oauth2/callback?code=one-time",
          },
        });
      }
      assert.ok(!cookie.includes("pocket-session"));
      if (url.pathname === "/oauth2/callback") {
        assert.equal(cookie, "csrf=start");
        const headers = new Headers({
          location:
            fault === "wrong-target"
              ? "https://other.now.lab.test/"
              : options.target,
        });
        if (fault !== "missing-session") {
          headers.append(
            "set-cookie",
            "__Secure-leolab_gateway_0=part0; Domain=lab.test; Secure; HttpOnly; SameSite=Lax",
          );
          headers.append(
            "set-cookie",
            "__Secure-leolab_gateway_1=part1; Domain=lab.test; Secure; HttpOnly; SameSite=Lax",
          );
        }
        headers.append("set-cookie", "csrf=; Max-Age=0; Secure");
        return new Response(null, { status: 302, headers });
      }
      assert.equal(url.pathname, "/oauth2/auth");
      assert.ok(!cookie.includes("csrf="));
      return new Response(null, {
        status: fault === "denied" ? 401 : 202,
        headers: {
          "x-auth-request-user": fault === "wrong-user" ? "bob" : "alice",
        },
      });
    }) as typeof fetch,
  };
  const cookies = await gatewaySession(options);
  assert.equal(cookies.length, 2);
  assert.ok(
    cookies.every(
      (c) =>
        /HttpOnly/.test(c) &&
        /Secure/.test(c) &&
        /SameSite=None; Partitioned/.test(c) &&
        !/SameSite=Lax/.test(c),
    ),
  );
  for (const failure of [
    "external",
    "wrong-path",
    "wrong-target",
    "consent",
    "missing-session",
    "wrong-user",
    "denied",
  ]) {
    fault = failure;
    calls = 0;
    await assert.rejects(gatewaySession(options));
    if (["external", "wrong-path"].includes(failure)) assert.equal(calls, 1);
  }
  assert.equal(
    embeddedCookie("a=b; Secure; SameSite=Lax; Partitioned"),
    "a=b; Secure; SameSite=None; Partitioned",
  );
});
