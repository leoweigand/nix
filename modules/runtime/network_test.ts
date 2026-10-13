import { test } from "node:test";
import assert from "node:assert/strict";
import { restrictedFetch } from "./network.ts";

test("network policy rejects initial and redirected unapproved destinations", async () => {
  let calls = 0;
  const fetch = restrictedFetch(["https://approved.example"], async () => {
    calls++;
    return new Response(null, {
      status: 302,
      headers: { location: "https://other.example/secret" },
    });
  });
  await assert.rejects(fetch("https://other.example/"), /network policy/);
  assert.equal(calls, 0);
  await assert.rejects(fetch("https://approved.example/"), /network policy/);
  assert.equal(calls, 1);
});

test("approved POST redirects preserve 307 bodies and turn 303 into GET", async () => {
  const requests: Request[] = [];
  const fetch = restrictedFetch(["https://approved.example"], async (input) => {
    const request = input as Request;
    requests.push(request.clone());
    if (requests.length < 3)
      return new Response(null, {
        status: requests.length === 1 ? 307 : 303,
        headers: { location: `/step${requests.length}` },
      });
    return new Response("ok");
  });
  assert.equal(
    await (
      await fetch("https://approved.example/", {
        method: "POST",
        body: "payload",
      })
    ).text(),
    "ok",
  );
  assert.equal(await requests[1].text(), "payload");
  assert.equal(requests[2].method, "GET");
});
