import { defineHook } from "eve/hooks";
import { runtimeContext, loadJournal, saveJournal } from "../lib/context.ts";

export default defineHook({
  events: {
    "context.settled": (event, ctx) => {
      if (
        event.data.kind !== "compaction" ||
        event.data.outcome !== "completed"
      )
        return;
      const { sessions, ref } = runtimeContext(ctx);
      const ledger = sessions.open(ref);
      if (
        !ledger
          .getEntries()
          .some(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "eve-compaction" &&
              (entry.data as { id: string }).id === event.data.changeId,
          )
      ) {
        ledger.appendCustomEntry("eve-compaction", { id: event.data.changeId });
      }
    },
    "call.settled": (event, ctx) => {
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
    },
  },
});
