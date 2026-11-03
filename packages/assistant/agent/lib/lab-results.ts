import type { HookEvent, StreamEventHook } from "eve/hooks";
import { runtimeContext, loadJournal, saveJournal } from "./context.ts";

export const recordLabResult: StreamEventHook<
  HookEvent<"call.settled">,
  "call.settled"
> = (event, ctx) => {
  const { directory } = runtimeContext(ctx);
  const journal = loadJournal(directory);
  const entry = journal.entries.find(
    (entry) => entry.callId === event.data.callId,
  );
  if (!entry || event.data.outcome !== "completed") return;
  const output = event.data.output;
  entry.result =
    output && typeof output === "object" && "structuredContent" in output
      ? output.structuredContent
      : output;
  saveJournal(directory, journal);
};
