import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  jwtVerify,
} from "jose";
import {
  Connections,
  connectionRevision,
  issuer,
  resource,
  clientId,
  scopes,
} from "./connections.ts";
import { Sessions } from "./sessions.ts";
import { EveAssistant } from "./eve.ts";
import { readJson, writeJson } from "./storage.ts";
import type { ConversationMessage } from "./conversation.ts";
import type { ToolJournal } from "../agent/lib/context.ts";

const output = fileURLToPath(
  new URL("../.output/server/index.mjs", import.meta.url),
);
const preload = fileURLToPath(
  new URL("./fixtures/eve-network.mjs", import.meta.url),
);
type Step = { name: string; arguments: Record<string, unknown> } | string;

test(
  "built Eve uses authenticated MCP, renewed grants, audience filters and durable uncertain-write guards",
  { timeout: 120_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "eve-mcp-"));
    const engineDirectory = mkdtempSync(
      join(process.env.EVE_TEST_ENGINE_TMPDIR ?? tmpdir(), "eve-mcp-engine-"),
    );
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: "fixture",
      alg: "RS256",
    };
    const keys = createLocalJWKSet({ keys: [jwk] });
    let granted = scopes;
    let refreshRejected = false;
    let refreshCalls = 0;
    let issued = 0;
    let rejectedToken: string | undefined;
    let authRejections = 0;
    const requests: Array<{ method: string; tool?: string; token: string }> =
      [];
    const modelCalls: unknown[] = [];
    const steps: Step[] = [];
    let blockedWrite: (() => void) | undefined;
    let blockWrite = false;
    let releaseWrite: (() => void) | undefined;
    const tools = [
      "whoami",
      "search_documents",
      "search_bookmarks",
      "get_home_entity",
      "control_home_entities",
    ].map((name) => ({
      name,
      description: `Fixture ${name}`,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: true,
      },
    }));
    let fixtureUrl = "";
    const server = createServer(async (request, response) => {
      try {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const url = request.url!;
        const json = (data: unknown, status = 200) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(data));
        };
        if (url.includes("jwks")) return json({ keys: [jwk] });
        if (url.includes("oauth-protected-resource"))
          return json({
            resource,
            authorization_servers: [issuer],
            scopes_supported: scopes.split(" "),
          });
        if (
          url.includes("openid-configuration") ||
          url.includes("oauth-authorization-server")
        )
          return json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/.well-known/jwks.json`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            authorization_response_iss_parameter_supported: true,
            token_endpoint_auth_methods_supported: ["none"],
          });
        if (url === "/token") {
          const params = new URLSearchParams(raw);
          assert.equal(params.get("resource"), resource);
          assert.equal(params.get("client_id"), clientId);
          if (params.get("grant_type") === "refresh_token") {
            refreshCalls++;
            if (refreshRejected) return json({ error: "invalid_grant" }, 400);
          }
          const access_token = await new SignJWT({
            client_id: clientId,
            scope: granted,
          })
            .setProtectedHeader({ alg: "RS256", typ: "at+jwt", kid: "fixture" })
            .setIssuer(issuer)
            .setAudience(resource)
            .setSubject("fixture-owner")
            .setJti(String(++issued))
            .setIssuedAt()
            .setExpirationTime("10m")
            .sign(privateKey);
          return json({
            access_token,
            refresh_token: `refresh-${issued}`,
            token_type: "Bearer",
            expires_in: 600,
            scope: granted,
          });
        }
        if (url === "/v1/chat/completions") {
          const body = JSON.parse(raw);
          modelCalls.push(body);
          const step = steps.shift();
          assert.notEqual(step, undefined, JSON.stringify(body));
          response.writeHead(200, { "content-type": "text/event-stream" });
          const event = (delta: unknown, finish_reason: string | null = null) =>
            response.write(
              `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
            );
          event({ role: "assistant" });
          if (typeof step === "string") event({ content: step });
          else
            event({
              tool_calls: [
                {
                  index: 0,
                  id: `call-${modelCalls.length}`,
                  type: "function",
                  function: {
                    name: step!.name,
                    arguments: JSON.stringify(step!.arguments),
                  },
                },
              ],
            });
          event({}, typeof step === "string" ? "stop" : "tool_calls");
          return response.end("data: [DONE]\n\n");
        }
        if (url.startsWith("/mcp")) {
          const token =
            request.headers.authorization?.replace(/^Bearer /, "") ?? "";
          if (!token || token === rejectedToken) {
            authRejections++;
            return json({ error: "unauthorised" }, 401);
          }
          await jwtVerify(token, keys, { issuer, audience: resource });
          if (request.method === "GET") return json({}, 405);
          if (request.method === "DELETE") return response.writeHead(204).end();
          const body = JSON.parse(raw);
          requests.push({
            method: body.method,
            tool: body.params?.name,
            token,
          });
          if (body.id === undefined) return response.writeHead(202).end();
          let result: unknown;
          if (body.method === "initialize")
            result = {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            };
          else if (body.method === "tools/list") result = { tools };
          else if (body.method === "tools/call") {
            if (blockWrite && body.params.name === "control_home_entities") {
              blockWrite = false;
              await new Promise<void>((resolve) => {
                releaseWrite = resolve;
                blockedWrite?.();
              });
              return response.end();
            }
            const structuredContent =
              body.params.name === "whoami"
                ? { subject: "fixture-owner" }
                : body.params.name === "control_home_entities"
                  ? {
                      results: [
                        { entityId: "light.fixture", outcome: "confirmed" },
                      ],
                    }
                  : { state: "on", documents: [], bookmarks: [] };
            result = {
              content: [
                { type: "text", text: JSON.stringify(structuredContent) },
              ],
              structuredContent,
            };
          } else
            return json({
              jsonrpc: "2.0",
              id: body.id,
              error: { code: -32601, message: "Unknown method" },
            });
          return json({ jsonrpc: "2.0", id: body.id, result });
        }
        json({}, 404);
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    fixtureUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const reserve = createServer();
    reserve.listen(0, "127.0.0.1");
    await once(reserve, "listening");
    const port = (reserve.address() as { port: number }).port;
    await new Promise<void>((resolve) => reserve.close(() => resolve()));
    const instructions = {
      system: "Follow the fixture request using lab tools.",
      channel: "Plain text.",
      channelName: "test",
    };
    const instructionPath = join(directory, "instructions.json");
    writeJson(instructionPath, instructions);
    const sessions = new Sessions(directory, () => instructions);
    const assistant = new EveAssistant(directory, sessions);
    const connection = new Connections({
      stateDir: directory,
      telegramId: "123",
      subject: "fixture-owner",
      callbackUrl: "https://example.org/callback",
      keys,
      fetch: (input, init) => {
        const source = new URL(String(input));
        return fetch(`${fixtureUrl}${source.pathname}${source.search}`, init);
      },
    });
    const connectionPath = join(directory, "connections/123/connection.json");
    async function consent() {
      const url = new URL(await connection.begin("123"));
      await connection.complete(
        new URL(
          `https://example.org/callback?code=fixture&iss=${encodeURIComponent(issuer)}&state=${url.searchParams.get("state")}`,
        ),
      );
    }
    function expire() {
      const state = readJson<any>(connectionPath)!;
      state.oauth.tokensExpireAt = 0;
      writeJson(connectionPath, state);
    }
    const oldEnv = { ...process.env };
    Object.assign(process.env, {
      ASSISTANT_EVE_URL: `http://127.0.0.1:${port}/internal/turn`,
      TELEGRAM_DESTINATIONS: "leo:123",
      TELEGRAM_WEBHOOK_SECRET: "fixture-secret",
    });
    let engine: ChildProcess | undefined;
    let logs = "";
    async function start() {
      engine = spawn(process.execPath, ["--import", preload, output], {
        cwd: engineDirectory,
        env: {
          ...process.env,
          PORT: String(port),
          HOST: "127.0.0.1",
          NITRO_PORT: String(port),
          NITRO_HOST: "127.0.0.1",
          WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${port}`,
          WORKFLOW_INLINE_OWNERSHIP: "0",
          ASSISTANT_AI_URL: `${fixtureUrl}/v1`,
          ASSISTANT_STATE_DIR: directory,
          ASSISTANT_EVE_STATE_DIR: engineDirectory,
          ASSISTANT_INSTRUCTIONS_FILE: instructionPath,
          ASSISTANT_POCKET_ID_SUBJECT: "fixture-owner",
          ASSISTANT_OAUTH_CALLBACK_URL: "https://example.org/callback",
          EVE_FIXTURE_URL: fixtureUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of [engine.stdout!, engine.stderr!])
        stream.on("data", (chunk) => {
          logs += chunk;
          if (process.env.EVE_DEBUG_TEST) process.stderr.write(chunk);
        });
      for (let i = 0; i < 100; i++) {
        try {
          if (
            (await fetch(`http://127.0.0.1:${port}/internal/healthz`))
              .status === 204
          )
            return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(logs);
    }
    async function stop(signal: NodeJS.Signals = "SIGTERM") {
      if (engine && engine.exitCode === null && engine.signalCode === null) {
        engine.kill(signal);
        await once(engine, "exit");
      }
    }
    const ref = sessions.select("fixture", Date.now());
    const message = (
      eventId: string,
      audience: "private" | "shared" = "private",
    ): ConversationMessage => ({
      eventId,
      conversationId: "fixture",
      author: "Leo",
      text: eventId,
      kind: "human",
      audience,
      at: Date.now(),
    });
    const answer = async (
      eventId: string,
      audience: "private" | "shared" = "private",
    ) =>
      assistant.answer(
        message(eventId, audience),
        ref,
        await connection.token("123"),
      );
    const search = { name: "eve__search", arguments: { query: "leolab" } };
    const call = (name: string, input: Record<string, unknown> = {}) => ({
      name: "eve__tool",
      arguments: { name: `leolab__${name}`, input },
    });
    const count = (name: string) =>
      requests.filter((request) => request.tool === name).length;
    try {
      await start();
      steps.push(search, { name: "connect_mcp", arguments: {} });
      assert.equal((await answer("missing")).needsConnection, true);
      assert.equal(requests.length, 0, "A missing grant must not reach MCP");
      assert.equal(
        authRejections,
        0,
        "Missing grants must not make anonymous MCP requests",
      );
      await consent();
      const revision = connectionRevision(directory, "123");
      steps.push(search, call("whoami"), "CONNECTED");
      assert.match((await answer("missing")).text, /CONNECTED/);
      assert.equal(count("whoami"), 1);
      assert.equal(steps.length, 0);

      const staleToken = await connection.token("123");
      expire();
      steps.push(search, call("whoami"), "REFRESHED");
      assert.match(
        (await assistant.answer(message("refresh"), ref, staleToken)).text,
        /REFRESHED/,
      );
      const refreshed = await connection.token("123");
      assert.equal(refreshCalls, 1);
      assert.equal(connectionRevision(directory, "123"), revision);
      assert.equal(
        requests.filter((request) => request.tool === "whoami").at(-1)?.token,
        refreshed,
      );

      // An authenticated transport rejection is not a successful tool result.
      // Reconsent with the SAME identity/scopes must get a new delivery/result.
      rejectedToken = refreshed;
      steps.push(search, { name: "connect_mcp", arguments: {} });
      assert.equal((await answer("revoked")).needsConnection, true);
      assert.ok(
        authRejections > 0,
        "The actual MCP transport must observe the revoked grant's HTTP 401",
      );
      const rejectedDiscovery = (modelCalls.at(-1) as any).messages
        .filter((entry: any) => entry.role === "tool")
        .at(-1).content;
      assert.match(rejectedDiscovery, /unavailable|authorization/i);
      const beforeReconsent = count("whoami");
      await consent();
      assert.notEqual(connectionRevision(directory, "123"), revision);
      steps.push(search, call("whoami"), "RECONSENTED");
      assert.match((await answer("revoked")).text, /RECONSENTED/);
      assert.equal(count("whoami"), beforeReconsent + 1);
      assert.equal(steps.length, 0);

      // Refresh denial removes the expired grant and exposes no MCP tools.
      expire();
      refreshRejected = true;
      const beforeExpired = requests.length;
      steps.push(search, { name: "connect_mcp", arguments: {} });
      assert.equal((await answer("expired")).needsConnection, true);
      assert.equal(requests.length, beforeExpired);
      refreshRejected = false;
      await consent();
      steps.push(search, call("whoami"), "RESUMED");
      assert.match((await answer("expired")).text, /RESUMED/);

      // Discovery and execution must both exclude private tools in shared chat,
      // even after the same principal used them privately in this process.
      steps.push(
        search,
        call("search_documents"),
        call("search_bookmarks"),
        "PRIVATE",
      );
      assert.match((await answer("private")).text, /PRIVATE/);
      assert.equal(count("search_documents"), 1);
      assert.equal(count("search_bookmarks"), 1);
      const sharedOffset = modelCalls.length;
      steps.push(
        search,
        call("search_documents"),
        call("search_bookmarks"),
        call("whoami"),
        "SHARED",
      );
      assert.match((await answer("shared", "shared")).text, /SHARED/);
      assert.equal(count("search_documents"), 1);
      assert.equal(count("search_bookmarks"), 1);
      const sharedDiscovery = (modelCalls[sharedOffset + 1] as any).messages
        .filter((entry: any) => entry.role === "tool")
        .at(-1).content;
      assert.doesNotMatch(
        sharedDiscovery,
        /leolab__search_documents|leolab__search_bookmarks/,
      );
      assert.match(sharedDiscovery, /leolab__whoami/);

      // A completed write result is journalled and releases the target guard.
      const input = { entityIds: ["light.fixture"], action: "turn_on" };
      steps.push(
        call("control_home_entities", input),
        call("control_home_entities", input),
        "CONFIRMED",
      );
      assert.match((await answer("confirmed")).text, /CONFIRMED/);
      assert.equal(count("control_home_entities"), 2);
      const confirmed = readJson<ToolJournal>(
        join(directory, "eve-requests/confirmed/tools.json"),
      )!;
      assert.equal(confirmed.entries.length, 2);
      assert.ok(confirmed.entries.every((entry) => entry.result !== undefined));

      blockWrite = true;
      const writeStarted = new Promise<void>((resolve) => {
        blockedWrite = resolve;
      });
      steps.push(call("control_home_entities", input));
      const interrupted = answer("uncertain").then(
        (value) => ({ value, error: undefined }),
        (error) => ({ value: undefined, error }),
      );
      await writeStarted;
      const pending = readJson<ToolJournal>(
        join(directory, "eve-requests/uncertain/tools.json"),
      )!;
      assert.equal(pending.entries.length, 1);
      assert.equal(pending.entries[0].result, undefined);
      assert.deepEqual(pending.writeAttempt?.entityIds, ["light.fixture"]);
      await stop("SIGKILL");
      releaseWrite?.();
      assert.ok((await interrupted).error);
      // Deliberately ask for another call after recovery: neither the suspended
      // call nor the model's new attempt may repeat the uncertain side effect.
      steps.push(
        call("control_home_entities", input),
        call("get_home_entity", { entityId: "light.fixture" }),
        "UNCERTAIN_CHECKED",
      );
      await start();
      assert.match((await answer("uncertain")).text, /UNCERTAIN_CHECKED/);
      assert.equal(count("control_home_entities"), 3);
      assert.equal(count("get_home_entity"), 1);
      const beforeReplay = modelCalls.length;
      await stop();
      await start();
      assert.match((await answer("uncertain")).text, /UNCERTAIN_CHECKED/);
      assert.equal(modelCalls.length, beforeReplay);
      assert.equal(count("control_home_entities"), 3);
      assert.equal(steps.length, 0);
    } catch (error) {
      console.error(
        logs,
        JSON.stringify(
          modelCalls.map((call: any) =>
            call.messages.filter((message: any) => message.role === "tool"),
          ),
        ),
        {
          directory,
          engineDirectory,
        },
      );
      throw error;
    } finally {
      releaseWrite?.();
      await stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      process.env = oldEnv;
      if (!process.env.EVE_KEEP_FIXTURE) {
        rmSync(directory, { recursive: true, force: true });
        rmSync(engineDirectory, { recursive: true, force: true });
      }
    }
  },
);
