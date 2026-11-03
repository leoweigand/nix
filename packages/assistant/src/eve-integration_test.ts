import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { Sessions } from "./sessions.ts";
import { writeJson } from "./storage.ts";

const output = fileURLToPath(
  new URL("../.output/server/index.mjs", import.meta.url),
);

for (const interruption of process.env.EVE_LIVE_TEST === "1"
  ? ["after-reply"]
  : ["after-reply", "root-inference", "coder-inference"])
  test(
    `built Eve server recovers ${interruption}, delegates and preserves guards`,
    { timeout: 90_000 },
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "eve-integration-"));
      const calls: Array<{
        model: string;
        tools: string[];
        messages: unknown[];
      }> = [];
      let blockedOnce = false;
      let reportBlocked!: () => void;
      let releaseInference: (() => void) | undefined;
      const blocked = new Promise<void>((resolve) => {
        reportBlocked = resolve;
      });
      const model = createServer(async (request, response) => {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw);
        const tools = (body.tools ?? []).map(
          (tool: { function: { name: string } }) => tool.function.name,
        );
        calls.push({ model: body.model, tools, messages: body.messages });
        if (
          !blockedOnce &&
          ((interruption === "root-inference" &&
            body.model === "claude-haiku-5-5") ||
            (interruption === "coder-inference" &&
              body.model === "deepseek-v4.1-flash"))
        ) {
          blockedOnce = true;
          await new Promise<void>((resolve) => {
            releaseInference = resolve;
            reportBlocked();
          });
          return response.end();
        }
        if (process.env.EVE_LIVE_TEST === "1") {
          const upstream = await fetch(
            "https://ai.internal.leolab.party/v1/chat/completions",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: raw,
            },
          );
          response.writeHead(upstream.status, {
            "content-type":
              upstream.headers.get("content-type") ?? "application/json",
          });
          if (upstream.body)
            for await (const chunk of upstream.body) response.write(chunk);
          response.end();
          return;
        }
        let name: string | undefined;
        let args: unknown;
        let text = "";
        const delegated = body.messages.some(
          (message: {
            role: string;
            tool_calls?: Array<{ function: { name: string } }>;
          }) =>
            message.role === "assistant" &&
            message.tool_calls?.some((call) => call.function.name === "coder"),
        );
        const completed = body.messages.some(
          (message: { role: string; content?: string }) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.startsWith("<task_result") &&
            message.content.includes("CODER_VERIFIED"),
        );
        if (body.model === "deepseek-v4.1-flash")
          text = "export const answer = 42; // CODER_VERIFIED";
        else if (!delegated) {
          name = "coder";
          args = {
            message: "Write a TypeScript constant named answer with value 42.",
          };
        } else if (!completed) {
          name = "eve__task_wait";
          args = {};
        } else
          text = "CODER_VERIFIED: the coding specialist returned TypeScript.";
        response.writeHead(200, { "content-type": "text/event-stream" });
        const event = (delta: unknown, finish_reason: string | null = null) =>
          response.write(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          );
        event({ role: "assistant" });
        if (name)
          event({
            tool_calls: [
              {
                index: 0,
                id: `call_${calls.length}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          });
        else event({ content: text });
        event({}, name ? "tool_calls" : "stop");
        response.end("data: [DONE]\n\n");
      });
      model.listen(0, "127.0.0.1");
      await once(model, "listening");
      const modelPort = (model.address() as { port: number }).port;
      const reserve = createServer();
      reserve.listen(0, "127.0.0.1");
      await once(reserve, "listening");
      const port = (reserve.address() as { port: number }).port;
      await new Promise<void>((resolve) => reserve.close(() => resolve()));
      const instructions = {
        system:
          "Delegate coding to coder, wait for its result, then report it. Include CODER_VERIFIED in your final answer when the coder returns that marker.",
        channel: "Reply as plain text.",
        channelName: "test",
      };
      const instructionPath = join(directory, "instructions.json");
      writeJson(instructionPath, instructions);
      const sessions = new Sessions(directory, () => instructions);
      const ref = sessions.select("fixture", Date.now());
      const message = {
        eventId: "human-fixture",
        conversationId: "fixture",
        author: "Leo",
        text: "Please ask the coder to write a TypeScript constant named answer with value 42 and a CODER_VERIFIED comment. Report the result and include the comment marker. Do not use other tools.",
        kind: "human",
        audience: "private",
        at: Date.now(),
      };
      sessions.record(ref, message as Parameters<Sessions["record"]>[1]);
      writeJson(
        join(directory, "eve-requests", message.eventId, "request.json"),
        { message, ref, senderId: "123" },
      );
      let engine: ChildProcess | undefined;
      let logs = "";
      async function start() {
        engine = spawn(process.execPath, [output], {
          cwd: directory,
          env: {
            ...process.env,
            PORT: String(port),
            HOST: "127.0.0.1",
            NITRO_PORT: String(port),
            NITRO_HOST: "127.0.0.1",
            WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${port}`,
            WORKFLOW_INLINE_OWNERSHIP: "0",
            ASSISTANT_AI_URL: `http://127.0.0.1:${modelPort}/v1`,
            ASSISTANT_STATE_DIR: directory,
            ASSISTANT_INSTRUCTIONS_FILE: instructionPath,
            TELEGRAM_WEBHOOK_SECRET: "fixture-secret",
            TELEGRAM_DESTINATIONS: "leo:123",
            ASSISTANT_POCKET_ID_SUBJECT: "fixture",
            ASSISTANT_OAUTH_CALLBACK_URL: "https://example.org/callback",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        engine.stdout!.on("data", (chunk) => {
          logs += chunk;
          if (process.env.EVE_DEBUG_TEST) process.stderr.write(chunk);
        });
        engine.stderr!.on("data", (chunk) => {
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
      const turn = () =>
        fetch(`http://127.0.0.1:${port}/internal/turn`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-assistant-secret": "fixture-secret",
          },
          body: JSON.stringify({ eventId: message.eventId }),
          signal: AbortSignal.timeout(50_000),
        });
      try {
        await start();
        assert.equal(
          (
            await fetch(`http://127.0.0.1:${port}/internal/turn`, {
              method: "POST",
            })
          ).status,
          401,
        );
        assert.equal(
          (await fetch(`http://127.0.0.1:${port}/eve/v1/info`)).status,
          404,
        );
        const initial = turn().then(
          (response) => ({ response, error: undefined }),
          (error: unknown) => ({ response: undefined, error }),
        );
        if (interruption !== "after-reply") {
          await blocked;
          engine!.kill("SIGKILL");
          await once(engine!, "exit");
          releaseInference?.();
          assert.ok(
            (await initial).error,
            "Interrupted HTTP turn must disconnect",
          );
          await start();
        }
        const response =
          interruption === "after-reply"
            ? (await initial).response!
            : await turn();
        const result = await response.text();
        assert.equal(response.status, 200, `${result}\n${logs}`);
        assert.match(result, /CODER_VERIFIED/, `${result}\n${logs}`);
        assert.ok(calls.some((call) => call.model === "deepseek-v4.1-flash"));
        for (const call of calls)
          assert.ok(
            !call.tools.some((tool) =>
              ["bash", "read_file", "write_file", "agent"].includes(tool),
            ),
            JSON.stringify(call),
          );
        const before = calls.length;
        engine!.kill("SIGTERM");
        await once(engine!, "exit");
        await start();
        const repeated = await turn();
        assert.equal(repeated.status, 200, logs);
        assert.match(await repeated.text(), /CODER_VERIFIED/);
        assert.equal(
          calls.length,
          before,
          "A completed delivery must not invoke either model again after restart",
        );
        const followup = {
          ...message,
          eventId: "human-followup",
          text: "What did the coder return? Include its CODER_VERIFIED marker. Do not delegate again.",
        };
        writeJson(
          join(directory, "eve-requests", followup.eventId, "request.json"),
          { message: followup, ref, senderId: "123" },
        );
        const continued = await fetch(
          `http://127.0.0.1:${port}/internal/turn`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-assistant-secret": "fixture-secret",
            },
            body: JSON.stringify({ eventId: followup.eventId }),
            signal: AbortSignal.timeout(50_000),
          },
        );
        assert.match(await continued.text(), /CODER_VERIFIED/, logs);
        assert.equal(
          calls.length,
          before + 1,
          "A settled reply must not replay inference during recovery",
        );
        assert.equal(
          calls.filter((call) => call.model === "deepseek-v4.1-flash").length,
          interruption === "coder-inference" ? 2 : 1,
          "Only an interrupted coder inference may run again; follow-up uses durable history",
        );
        assert.match(
          readFileSync(
            join(directory, "eve-requests", message.eventId, "request.json"),
            "utf8",
          ),
          /human-fixture/,
        );
      } catch (error) {
        console.error(
          logs,
          JSON.stringify(calls.map(({ model, tools }) => ({ model, tools }))),
          directory,
        );
        throw error;
      } finally {
        releaseInference?.();
        if (engine && engine.exitCode === null && engine.signalCode === null) {
          engine.kill("SIGTERM");
          await once(engine, "exit");
        }
        await new Promise<void>((resolve) => model.close(() => resolve()));
        if (!process.env.EVE_KEEP_FIXTURE)
          rmSync(directory, { recursive: true, force: true });
      }
    },
  );
