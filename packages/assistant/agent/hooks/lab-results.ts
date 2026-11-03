import { defineHook } from "eve/hooks";
import { runtimeContext } from "../lib/context.ts";
import { recordLabResult } from "../lib/lab-results.ts";

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
    "call.settled": recordLabResult,
  },
});
