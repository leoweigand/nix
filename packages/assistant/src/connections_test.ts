import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  Connections,
  clientId,
  issuer,
  resource,
  scopes,
} from "./connections.ts";
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "assistant-auth-test-"));
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  let now = Date.now();
  let subject = "leo-subject";
  let granted = "lab:read media:read media:request";
  let refreshToken = "refresh-1";
  let refreshCalls = 0;
  let challenge = "";
  let tokenError = false;
  const requests: { url: string; body?: URLSearchParams }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body
      ? new URLSearchParams(String(init.body))
      : undefined;
    requests.push({ url, body });
    if (url.includes("oauth-protected-resource"))
      return Response.json({
        resource,
        authorization_servers: [issuer],
        scopes_supported: scopes.split(" "),
      });
    if (
      url.includes("openid-configuration") ||
      url.includes("oauth-authorization-server")
    )
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/api/oidc/token`,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (url.endsWith("/api/oidc/token")) {
      assert.equal(body?.get("client_id"), clientId);
      assert.equal(body?.get("resource"), resource);
      if (tokenError)
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (body?.get("grant_type") === "authorization_code") {
        assert.equal(
          createHash("sha256")
            .update(body.get("code_verifier")!)
            .digest("base64url"),
          challenge,
        );
        assert.equal(
          body.get("redirect_uri"),
          "https://webhooks.leolab.party/assistant/oauth/callback",
        );
      } else {
        assert.equal(body?.get("grant_type"), "refresh_token");
        assert.equal(body?.get("refresh_token"), refreshToken);
        refreshToken = `refresh-${++refreshCalls + 1}`;
      }
      const access_token = await new SignJWT({
        client_id: clientId,
        scope: granted,
      })
        .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "fixture" })
        .setIssuer(issuer)
        .setAudience(resource)
        .setSubject(subject)
        .setIssuedAt(Math.floor(now / 1000))
        .setExpirationTime(Math.floor(now / 1000) + 600)
        .sign(privateKey);
      return Response.json({
        access_token,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: 600,
        scope: granted,
      });
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  };
  const options = {
    stateDir: directory,
    telegramId: "123",
    subject: "leo-subject",
    callbackUrl: "https://webhooks.leolab.party/assistant/oauth/callback",
    fetch: fakeFetch,
    keys: createLocalJWKSet({
      keys: [{ ...jwk, kid: "fixture", alg: "RS256" }],
    }),
    now: () => now,
  };
  const connection = new Connections(options);
  async function begin() {
    const url = new URL(await connection.begin("123"));
    challenge = url.searchParams.get("code_challenge")!;
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("scope"), scopes);
    return new URL(
      `${options.callbackUrl}?code=fixture-code&iss=${encodeURIComponent(issuer)}&state=${url.searchParams.get("state")}`,
    );
  }
  return {
    directory,
    options,
    connection,
    begin,
    requests,
    advance: () => {
      now += 8 * 60000;
    },
    expire: () => {
      now += 11 * 60000;
    },
    setSubject: (s: string) => {
      subject = s;
    },
    setScope: (s: string) => {
      granted = s;
    },
    failRefresh: () => {
      tokenError = true;
    },
    refreshCalls: () => refreshCalls,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("OAuth binds the verified identity, persists across restarts, refreshes and rotates the grant", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.connection.token("123"), undefined);
    const callback = await f.begin();
    assert.equal(
      await f.connection.begin("123"),
      await f.connection.begin("123"),
    );
    await f.connection.complete(callback);
    assert.ok(await new Connections(f.options).token("123"));
    await assert.rejects(f.connection.complete(callback));
    await assert.rejects(f.connection.token("999"));
    f.advance();
    assert.ok(await f.connection.token("123"));
    assert.equal(f.refreshCalls(), 1);
    const stored = JSON.parse(
      readFileSync(
        join(f.directory, "connections/123/connection.json"),
        "utf8",
      ),
    );
    assert.equal(stored.subject, "leo-subject");
    assert.equal(stored.oauth.tokens.refresh_token, "refresh-2");
    f.advance();
    f.failRefresh();
    assert.equal(await f.connection.token("123"), undefined);
  } finally {
    f.cleanup();
  }
});
test("wrong state and issuer, expired links, replay, and a different Pocket ID cannot bind credentials", async () => {
  for (const kind of ["state", "issuer", "expired", "subject", "scope"]) {
    const f = await fixture();
    try {
      const callback = await f.begin();
      if (kind === "state") callback.searchParams.set("state", "wrong-state");
      if (kind === "issuer")
        callback.searchParams.set("iss", "https://wrong.example");
      if (kind === "expired") f.expire();
      if (kind === "subject") f.setSubject("another-subject");
      if (kind === "scope") f.setScope("media:read");
      await assert.rejects(f.connection.complete(callback));
      assert.equal(await f.connection.token("123"), undefined);
    } finally {
      f.cleanup();
    }
  }
});
