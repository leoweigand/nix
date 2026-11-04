import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchPublic,
  publicAddress,
  resolvePublic,
  validateNetwork,
  MAX_BODY,
} from "./egress.ts";

const origins = ["https://api.example.com", "https://other.example.com"];
const input = {
  url: origins[0] + "/weather",
  method: "GET",
  headers: {},
  body: "",
};
const publicDns = async () => [{ address: "1.1.1.1", family: 4 }];
test("destinations require exact HTTPS DNS origins", () => {
  validateNetwork(undefined);
  validateNetwork({ server: origins });
  for (const origin of [
    "http://api.example.com",
    "https://127.0.0.1",
    "https://[::1]",
    "https://api.example.com/path",
    "https://api.example.com:444",
    "https://u:p@api.example.com",
    "https://localhost",
    "https://api.example.com.",
  ])
    assert.throws(() => validateNetwork({ server: [origin] }));
  assert.throws(() => validateNetwork({ server: Array(17).fill(origins[0]) }));
  assert.throws(() => validateNetwork({ server: origins, browser: ["*"] }));
});
test("private, shared, reserved, translated and transition addresses are blocked", async () => {
  for (const ip of [
    "0.0.0.0",
    "127.0.0.1",
    "10.1.2.3",
    "100.70.11.110",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.2.4",
    "198.18.1.1",
    "224.1.1.1",
    "255.255.255.255",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:8.8.8.8",
    "fc00::1",
    "fe80::1",
    "64:ff9b::a00:1",
    "2002:7f00:1::",
    "2001:db8::1",
    "2001::1",
    "3fff::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(publicAddress(ip), true, ip);
  await assert.rejects(
    resolvePublic(
      "mixed.example",
      async () =>
        [...(await publicDns()), { address: "127.0.0.1", family: 4 }] as any,
    ),
    /private/,
  );
});
test("fetch pins checked DNS, strips host identity headers and returns API data", async () => {
  let calls = 0;
  const result = await fetchPublic(
    {
      ...input,
      headers: {
        cookie: "private",
        "X-Now-User-ID": "private",
        "X-Auth-Request-User": "private",
        Host: "internal",
        Authorization: "Bearer app-api-key",
      },
    },
    origins,
    {
      resolve: publicDns as any,
      request: async (url, method, headers, body, addresses) => {
        calls++;
        assert.equal(url.hostname, "api.example.com");
        assert.deepEqual(addresses, await publicDns());
        assert.equal(headers.get("cookie"), null);
        assert.equal(headers.get("host"), null);
        assert.equal(headers.get("x-now-user-id"), null);
        assert.equal(headers.get("x-auth-request-user"), null);
        assert.equal(headers.get("authorization"), "Bearer app-api-key");
        return Response.json({ temperature: 12 });
      },
    },
  );
  assert.equal(calls, 1);
  assert.deepEqual(await result.json(), { temperature: 12 });
});
test("redirects recheck origin and DNS before connecting and drop cross-origin credentials", async () => {
  let calls = 0;
  await assert.rejects(
    fetchPublic(input, origins, {
      resolve: publicDns as any,
      request: async () => {
        calls++;
        return Response.redirect("https://undeclared.example/path");
      },
    }),
    /not declared/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    fetchPublic(input, origins, {
      resolve: (async (hostname: string) =>
        hostname === "other.example.com"
          ? [{ address: "192.168.2.4", family: 4 }]
          : publicDns()) as any,
      request: async () => {
        calls++;
        return Response.redirect(origins[1]!);
      },
    }),
    /private/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await fetchPublic(
    { ...input, headers: { authorization: "secret", "x-api-key": "secret" } },
    origins,
    {
      resolve: publicDns as any,
      request: async (_url, _method, headers) => {
        if (++calls === 1) return Response.redirect(origins[1]!);
        assert.equal(headers.get("authorization"), null);
        assert.equal(headers.get("x-api-key"), null);
        return new Response("ok");
      },
    },
  );
});
test("empty permissions, credential URLs, redirect loops, bodies and slow DNS fail closed", async () => {
  const never = async () => {
    throw new Error("must not connect");
  };
  await assert.rejects(
    fetchPublic(input, [], { request: never }),
    /not declared/,
  );
  await assert.rejects(
    fetchPublic({ ...input, url: "https://u:p@api.example.com/" }, origins, {
      request: never,
    }),
    /not declared/,
  );
  await assert.rejects(
    fetchPublic(
      { ...input, body: Buffer.alloc(MAX_BODY + 1).toString("base64") },
      origins,
    ),
    /body exceeds/,
  );
  let calls = 0;
  await assert.rejects(
    fetchPublic(input, origins, {
      resolve: publicDns as any,
      request: async () => {
        calls++;
        return Response.redirect(input.url);
      },
    }),
    /redirects/,
  );
  assert.equal(calls, 4);
  await assert.rejects(
    fetchPublic(input, origins, {
      timeoutMs: 5,
      resolve: (() => new Promise(() => {})) as any,
      request: never,
    }),
    /timed out/,
  );
});
