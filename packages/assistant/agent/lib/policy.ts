import type { ApprovalPolicy } from "eve/tools/approval";
import {
  HomeWriteGuard,
  BookmarkWriteGuard,
  DocumentWriteGuard,
  availableTools,
  maxToolCalls,
  recordWrite,
} from "../../src/tools.ts";
import {
  connectionStore,
  runtimeContext,
  loadJournal,
  saveJournal,
} from "./context.ts";

export const labApproval: ApprovalPolicy = async (ctx) => {
  const { message, directory, senderId } = runtimeContext(ctx);
  const token = await connectionStore().token(senderId);
  const tool = ctx.toolName.replace(/^leolab__/, "mcp__leolab__");
  if (!availableTools(token, message.audience).includes(tool)) return "denied";
  const journal = loadJournal(directory);
  const result = prepareLabCall(
    journal,
    ctx.callId,
    tool,
    (ctx.toolInput ?? {}) as Record<string, unknown>,
  );
  if (result === "approved") saveJournal(directory, journal);
  return result;
};

export function prepareLabCall(
  journal: import("./context.ts").ToolJournal,
  callId: string,
  tool: string,
  input: Record<string, unknown>,
): "approved" | "denied" {
  // A repeated approval after a crash must not replay an uncertain remote call.
  if (
    journal.entries.some((entry) => entry.callId === callId) ||
    journal.entries.length >= maxToolCalls
  )
    return "denied";
  const home = new HomeWriteGuard(),
    bookmarks = new BookmarkWriteGuard(),
    documents = new DocumentWriteGuard();
  try {
    for (const entry of journal.entries) {
      documents.before(entry.tool, entry.input);
      home.before(entry.tool, entry.input);
      bookmarks.before(entry.tool, entry.input);
      if (entry.result !== undefined) {
        home.after(entry.tool, entry.result);
        bookmarks.after(entry.tool, entry.result);
      }
    }
    documents.before(tool, input);
    home.before(tool, input);
    bookmarks.before(tool, input);
    recordWrite(tool, input, (attempt) => {
      journal.writeAttempt = attempt;
    });
    journal.entries.push({ callId: callId, tool, input });
    return "approved";
  } catch {
    return "denied";
  }
}
