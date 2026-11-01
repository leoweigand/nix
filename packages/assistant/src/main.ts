import { createServer } from "node:http";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Connections } from "./connections.ts";
import { Inbox, type Policy } from "./inbox.ts";
import { PiAssistant } from "./pi.ts";
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
const assistant = new PiAssistant(stateDir);
const worker = new Worker({
  secret,
  policy,
  inbox: new Inbox(join(stateDir, "inbox")),
  connections: new Connections({
    stateDir,
    telegramId: ownerId,
    subject,
    callbackUrl,
  }),
  assistant,
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
  worker.stopping = true;
  server.close();
  void assistant.active?.abort().finally(() => process.exit(0));
  if (!worker.working) process.exit(0);
});
