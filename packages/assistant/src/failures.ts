import { isWriteCall, type WriteAttempt } from "./tools.ts";
import type { ToolJournal } from "../agent/lib/context.ts";

export interface OperationState {
  state: "none" | "recorded" | "uncertain";
  tool?: string;
  app?: { name: string; url: string };
}
export function operationState(journal?: ToolJournal): OperationState {
  const writes =
    journal?.entries.filter((entry) => isWriteCall(entry.tool, entry.input)) ??
    [];
  if (!writes.length)
    return journal?.writeAttempt
      ? { state: "uncertain", tool: journal.writeAttempt.tool }
      : { state: "none" };
  let app: OperationState["app"];
  for (const entry of writes) {
    const result = entry.result as Record<string, any> | undefined;
    if (
      !result ||
      typeof result !== "object" ||
      result.isError ||
      ["uncertain", "unconfirmed", "request_unconfirmed"].includes(
        result.outcome,
      )
    )
      return { state: "uncertain", tool: entry.tool };
    const known = entry.tool.startsWith("mcp__leolab__now_")
      ? Boolean(
          result.app ||
          result.revision ||
          result.releaseId ||
          result.status ||
          ["error", "destroyed"].includes(result.outcome),
        ) &&
        !(typeof result.status === "number" && result.status >= 500) &&
        !(
          entry.tool === "mcp__leolab__now_request" &&
          (result.status < 200 || result.status >= 300)
        )
      : entry.tool === "mcp__leolab__save_bookmark"
        ? ["saved", "updated", "already_saved"].includes(result.outcome)
        : entry.tool === "mcp__leolab__ingest_document"
          ? result.outcome === "submitted" && typeof result.taskId === "string"
          : entry.tool === "mcp__leolab__control_home_entities"
            ? [
                "confirmed",
                "already_satisfied",
                "failed",
                "partial_failure",
              ].includes(result.outcome) &&
              Array.isArray(result.results) &&
              result.results.every((r: any) =>
                ["confirmed", "already_satisfied", "failed"].includes(
                  r.outcome,
                ),
              )
            : entry.tool === "mcp__leolab__request_media"
              ? [
                  "accepted",
                  "already_available",
                  "already_requested",
                  "needs_input",
                  "failed",
                ].includes(result.outcome) &&
                result.libraryChanged !== null &&
                result.searchStatus !== "unknown"
              : false;
    if (!known) return { state: "uncertain", tool: entry.tool };
    if (
      entry.tool === "mcp__leolab__now_destroy" ||
      result.outcome === "destroyed"
    )
      app = undefined;
    if (
      ["mcp__leolab__now_deploy", "mcp__leolab__now_rollback"].includes(
        entry.tool,
      ) &&
      result.app?.active &&
      typeof result.app.url === "string" &&
      URL.canParse(result.app.url) &&
      new URL(result.app.url).protocol === "https:"
    )
      app = { name: result.app.displayName ?? "The app", url: result.app.url };
  }
  return { state: "recorded", tool: writes.at(-1)?.tool, app };
}
export class AssistantFailure extends Error {
  kind: "response" | "generation";
  operations: OperationState;
  constructor(kind: AssistantFailure["kind"], operations: OperationState) {
    super(
      kind === "response" ? "Eve returned no response" : "Assistant run failed",
    );
    this.kind = kind;
    this.operations = operations;
  }
}
export function failureReply(
  state: OperationState,
  interrupted = false,
  attempt?: WriteAttempt,
) {
  if (state.state === "recorded")
    return state.app
      ? `${state.app.name} was deployed, but I couldn't prepare the completion message. You can open it here:\n${state.app.url}`
      : "The operation results were recorded, but I couldn't prepare the reply. Ask me to check the current state before continuing.";
  if (state.state === "uncertain" || attempt) {
    const tool = state.tool ?? attempt?.tool ?? "";
    const operation = tool.includes("now_")
      ? "app change"
      : tool.includes("control_home")
        ? "device command"
        : tool.includes("ingest_document")
          ? "document upload"
          : tool.includes("save_bookmark")
            ? "bookmark save"
            : tool.includes("request_media")
              ? "media request"
              : "change";
    const target =
      tool.includes("control_home") && attempt
        ? ` (${attempt.action ?? "control"}: ${attempt.entityIds?.join(", ") ?? "unknown target"})`
        : "";
    return `${interrupted ? "I was interrupted after starting" : "I couldn't confirm the result of"} the ${operation}${target}. I won't repeat it automatically; ask me to check its current state first.`;
  }
  return "I couldn't complete that request. Please try again shortly, or send /connect if my MCP connection needs renewing.";
}
