import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { SessionContext } from "eve/context";
import { Connections } from "../../src/connections.ts";
import {
  Sessions,
  type SessionRef,
  type Instructions,
} from "../../src/sessions.ts";
import { readJson, writeJson } from "../../src/storage.ts";
import type { ConversationMessage } from "../../src/conversation.ts";
import type { ReplyCard, ReplyButton } from "../../src/replies.ts";
import type { WriteAttempt } from "../../src/tools.ts";

export interface RuntimeRequest {
  message: ConversationMessage;
  senderId: string;
  context?: unknown;
  authRevision?: string;
  ref: SessionRef;
}
export interface RuntimeResult {
  needsConnection?: boolean;
  cards?: ReplyCard[];
  buttons?: ReplyButton[];
  reaction?: string;
}
export interface ToolEntry {
  callId: string;
  tool: string;
  input: Record<string, unknown>;
  result?: unknown;
}
export interface ToolJournal {
  entries: ToolEntry[];
  writeAttempt?: WriteAttempt;
  searchCalls?: number;
}
export function stateDir() {
  const directory = process.env.ASSISTANT_STATE_DIR;
  if (!directory) throw new Error("Missing assistant state directory");
  return directory;
}
export function requestDirectory(eventId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(eventId)) throw new Error("Invalid event ID");
  return join(stateDir(), "eve-requests", eventId);
}
let connections: Connections | undefined;
export function connectionStore() {
  if (connections) return connections;
  const telegramId = (process.env.TELEGRAM_DESTINATIONS ?? "")
    .split(",")
    .find((entry) => entry.startsWith("leo:"))
    ?.slice(4);
  const subject = process.env.ASSISTANT_POCKET_ID_SUBJECT;
  const callbackUrl = process.env.ASSISTANT_OAUTH_CALLBACK_URL;
  if (!telegramId || !subject || !callbackUrl)
    throw new Error("Missing connection configuration");
  connections = new Connections({
    stateDir: stateDir(),
    telegramId,
    subject,
    callbackUrl,
  });
  return connections;
}
export function runtimeContext(ctx: {
  session: { auth: SessionContext["session"]["auth"] };
}) {
  const auth = ctx.session.auth.current;
  if (
    auth?.authenticator !== "leolab-telegram" ||
    auth.principalType !== "user"
  )
    throw new Error("Missing trusted Telegram identity");
  const eventId = auth.attributes.eventId;
  if (typeof eventId !== "string") throw new Error("Missing request identity");
  const directory = requestDirectory(eventId);
  const request = readJson<RuntimeRequest>(join(directory, "request.json"));
  if (!request || request.senderId !== auth.principalId)
    throw new Error("Request identity mismatch");
  const sessions = new Sessions(
    stateDir(),
    () =>
      JSON.parse(
        readFileSync(process.env.ASSISTANT_INSTRUCTIONS_FILE!, "utf8"),
      ) as Instructions,
  );
  return { ...request, directory, sessions };
}
export function updateResult(
  ctx: { session: { auth: SessionContext["session"]["auth"] } },
  patch: RuntimeResult,
) {
  const { directory } = runtimeContext(ctx);
  const path = join(directory, "result.json");
  writeJson(path, { ...readJson<RuntimeResult>(path), ...patch });
}
export function loadJournal(directory: string): ToolJournal {
  return (
    readJson<ToolJournal>(join(directory, "tools.json")) ?? { entries: [] }
  );
}
export function saveJournal(directory: string, journal: ToolJournal) {
  writeJson(join(directory, "tools.json"), journal);
}
