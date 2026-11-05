import { defineHook } from "eve/hooks";
import { runtimeContext } from "../lib/context.ts";
import { recordReplyDraft } from "../../src/reply-draft.ts";

export default defineHook({
  events: {
    "content.completed": (event, ctx) =>
      recordReplyDraft(runtimeContext(ctx).directory, event),
    "call.requested": (event, ctx) =>
      recordReplyDraft(runtimeContext(ctx).directory, event),
    "call.settled": (event, ctx) =>
      recordReplyDraft(runtimeContext(ctx).directory, event),
  },
});
