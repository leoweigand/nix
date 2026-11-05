import { join } from "node:path";
import type { HookEvent } from "eve/hooks";
import { readJson, writeJson } from "./storage.ts";

type ReplyEvent = HookEvent<
  "content.completed" | "call.requested" | "call.settled"
>;
interface Draft {
  text: string;
  parts: string[];
  calls: Record<string, { name: string; completed: boolean }>;
}
interface Drafts {
  candidate?: string;
  runs: Record<string, Draft>;
}

// Only parent text attached to successful presentation calls is a fallback.
// Narration followed by coding, lab operations or failed calls is never a reply.
export function recordReplyDraft(directory: string, event: ReplyEvent) {
  const path = join(directory, "reply-draft.json");
  const state = readJson<Drafts>(path) ?? { runs: {} };
  if (event.type === "content.completed") {
    const data = event.data;
    if (
      data.kind !== "text" ||
      data.interrupted ||
      typeof data.value !== "string" ||
      !data.value.trim() ||
      !data.runId
    )
      return;
    const draft = (state.runs[data.runId] ??= {
      text: "",
      parts: [],
      calls: {},
    });
    if (!draft.parts.includes(data.partId)) {
      draft.parts.push(data.partId);
      draft.text += (draft.text ? "\n" : "") + data.value;
    }
    state.candidate = data.runId;
  } else if (event.type === "call.requested") {
    const { owner, capability, callId } = event.data;
    if (!("runId" in owner)) {
      delete state.candidate;
    } else {
      const draft = (state.runs[owner.runId] ??= {
        text: "",
        parts: [],
        calls: {},
      });
      draft.calls[callId] ??= { name: capability.name, completed: false };
      if (capability.name !== "telegram_buttons") delete state.candidate;
    }
  } else {
    for (const draft of Object.values(state.runs)) {
      const call = draft.calls[event.data.callId];
      if (call) call.completed = event.data.outcome === "completed";
    }
  }
  const ids = Object.keys(state.runs);
  for (const id of ids.slice(0, -16))
    if (id !== state.candidate) delete state.runs[id];
  writeJson(path, state);
}

export function presentationReply(directory: string): string | undefined {
  const state = readJson<Drafts>(join(directory, "reply-draft.json"));
  const draft = state?.candidate ? state.runs[state.candidate] : undefined;
  const calls = Object.values(draft?.calls ?? {});
  return draft?.text.trim() &&
    calls.length &&
    calls.every((call) => call.name === "telegram_buttons" && call.completed)
    ? draft.text.trim()
    : undefined;
}
