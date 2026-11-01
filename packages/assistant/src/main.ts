import { createServer } from "node:http";
import { join } from "node:path";
import {
  authorized,
  eligibleJob,
  Inbox,
  type Policy,
  type Job,
} from "./inbox.ts";
import { PiAssistant } from "./pi.ts";

const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const stateDir = process.env.ASSISTANT_STATE_DIR;
if (!secret || !stateDir) throw new Error("Missing assistant configuration");
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
const inbox = new Inbox(join(stateDir, "inbox"));
const assistant = new PiAssistant(stateDir);
let working = false;
let stopping = false;
async function gateway(endpoint: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:9087${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Telegram gateway HTTP ${response.status}`);
}
async function processJob(job: Job) {
  if (!job.reply) {
    const typing = () =>
      gateway("/v1/typing", { to: job.destination }).catch(() => {});
    await typing();
    const timer = setInterval(() => void typing(), 4500);
    try {
      job.reply = await assistant.answer(job);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "assistant_failed",
          updateId: job.id,
          error:
            error instanceof Error
              ? error.message.replace(/https?:\/\/\S+/g, "[endpoint]")
              : "unknown",
        }),
      );
      job.reply =
        "I couldn't complete that lookup. Please try again shortly. If it keeps failing, my MCP connection may need signing in again.";
    } finally {
      clearInterval(timer);
    }
    inbox.save(job);
  }
  await gateway("/v1/assistant-replies", {
    to: job.destination,
    message: job.reply,
    message_id: job.messageId,
    ...(job.topicId === undefined ? {} : { message_thread_id: job.topicId }),
    secret,
  });
  job.done = true;
  // Keep only a receipt for deduplication once delivery succeeds.
  job.text = "";
  delete job.reply;
  inbox.save(job);
  console.info(
    JSON.stringify({ event: "assistant_delivered", updateId: job.id }),
  );
}
async function drain() {
  if (working || stopping) return;
  working = true;
  try {
    for (const job of inbox.jobs().filter((j) => !j.done)) {
      if (stopping) break;
      try {
        await processJob(job);
      } catch {
        console.error(
          JSON.stringify({
            event: "assistant_delivery_failed",
            updateId: job.id,
          }),
        );
        break;
      }
    }
  } finally {
    working = false;
  }
}
const server = createServer(async (request, response) => {
  if (request.url === "/healthz" && request.method === "GET") {
    response.writeHead(204).end();
    return;
  }
  if (request.url !== "/inbox" || request.method !== "POST") {
    response.writeHead(404).end();
    return;
  }
  if (
    !authorized(
      typeof request.headers["x-assistant-secret"] === "string"
        ? request.headers["x-assistant-secret"]
        : null,
      secret,
    )
  ) {
    response.writeHead(401).end();
    return;
  }
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk.toString();
      if (Buffer.byteLength(body) > 1024 * 1024) {
        response.writeHead(413).end();
        return;
      }
    }
    const job = eligibleJob(JSON.parse(body), policy);
    if (!job) {
      response.writeHead(204).end();
      return;
    }
    const outcome = inbox.enqueue(job);
    response.writeHead(outcome === "full" ? 503 : 204).end();
    setImmediate(() => void drain());
  } catch {
    response.writeHead(400).end();
  }
});
server.listen(9090, "127.0.0.1", () => {
  console.info("Telegram assistant listening on loopback");
  void drain();
});
setInterval(() => void drain(), 10000);
process.on("SIGTERM", () => {
  stopping = true;
  server.close();
  void assistant.active?.abort().finally(() => process.exit(0));
  if (!working) process.exit(0);
});
