import { stageTelegramAttachment } from "./attachments.ts";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Connections } from "./connections.ts";
import { Inbox, type Policy } from "./inbox.ts";
import { EveAssistant } from "./eve.ts";
import { PiAssistant } from "./pi.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Sessions, type Instructions } from "./sessions.ts";
import { Worker } from "./worker.ts";
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const stateDir = process.env.ASSISTANT_STATE_DIR;
const subject = process.env.ASSISTANT_POCKET_ID_SUBJECT;
const callbackUrl = process.env.ASSISTANT_OAUTH_CALLBACK_URL;
if (!secret || !stateDir || !subject || !callbackUrl)
  throw new Error("Missing assistant configuration");
const destinations = new Map(
  (process.env.TELEGRAM_DESTINATIONS ?? "")
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.indexOf(":");
      return [entry.slice(0, separator), entry.slice(separator + 1)] as [
        string,
        string,
      ];
    }),
);
const ownerId = destinations.get("leo");
if (!ownerId || !/^\d+$/.test(ownerId))
  throw new Error("The leo destination must be a private Telegram chat ID");
const policy: Policy = {
  ownerId,
  destinations,
  botUsername: process.env.ASSISTANT_BOT_USERNAME,
};
const instructionPath = process.env.ASSISTANT_INSTRUCTIONS_FILE;
if (!instructionPath) throw new Error("Missing instruction bundle");
const sessions = new Sessions(
  stateDir,
  () => JSON.parse(readFileSync(instructionPath, "utf8")) as Instructions,
);
// The built engine is immutable; only its workflow data lives in the state directory.
const useEve = process.env.ASSISTANT_RUNTIME === "eve";
const engine = useEve
  ? spawn(
      process.execPath,
      [fileURLToPath(new URL("../.output/server/index.mjs", import.meta.url))],
      {
        cwd: stateDir,
        env: {
          ...process.env,
          PORT: "9091",
          HOST: "127.0.0.1",
          NITRO_HOST: "127.0.0.1",
          NITRO_PORT: "9091",
          WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:9091",
          // One engine owns this local world. Dead invocation leases must not
          // defer recovery; in-process step single-flight still prevents overlap.
          WORKFLOW_INLINE_OWNERSHIP: "0",
        },
        stdio: "inherit",
      },
    )
  : undefined;
let stopping = false;
engine?.on("exit", () => {
  if (!stopping) process.exit(1);
});
process.on("exit", () => engine?.kill("SIGTERM"));
if (engine)
  for (let attempt = 0; ; attempt++) {
    try {
      const health = await fetch("http://127.0.0.1:9091/internal/healthz");
      if (health.status === 204) break;
    } catch {}
    if (attempt >= 100) throw new Error("Eve engine did not start");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
const assistant = useEve
  ? new EveAssistant(stateDir, sessions)
  : new PiAssistant(stateDir, sessions);
const worker = new Worker({
  secret,
  sessions,
  policy,
  inbox: new Inbox(join(stateDir, "inbox")),
  connections: new Connections({
    stateDir,
    telegramId: ownerId,
    subject,
    callbackUrl,
  }),
  assistant,
  stageAttachment: (job, token) => stageTelegramAttachment(job, token, secret),
  gateway: async (endpoint, body) => {
    const response = await fetch(`http://127.0.0.1:9087${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(`Telegram gateway HTTP ${response.status}`);
  },
});
const server = createServer(async (incoming, outgoing) => {
  try {
    const request = new Request(
      new URL(incoming.url ?? "/", "http://127.0.0.1"),
      {
        method: incoming.method,
        headers: incoming.headers as Record<string, string>,
        ...(["GET", "HEAD"].includes(incoming.method ?? "GET")
          ? {}
          : {
              body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
              duplex: "half",
            }),
      },
    );
    const response = await worker.handle(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  } catch {
    outgoing.writeHead(500).end();
  }
});
server.requestTimeout = 30000;
server.listen(9090, "127.0.0.1", () => {
  console.info("Telegram assistant listening on loopback");
  void worker.drain();
});
setInterval(() => void worker.drain(), 10000);
process.on("SIGTERM", () => {
  stopping = true;
  worker.stopping = true;
  server.close();
  if (!engine) {
    void assistant.active?.abort().finally(() => process.exit(0));
    if (!worker.working) process.exit(0);
    return;
  }
  void (async () => {
    const deadline = Date.now() + 15_000;
    while (worker.working && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    engine?.kill("SIGTERM");
    // Eve's Node host drains outstanding HTTP work during its graceful shutdown.
    if (engine && engine.exitCode === null && engine.signalCode === null)
      await new Promise((resolve) => engine.once("exit", resolve));
    process.exit(0);
  })();
});
