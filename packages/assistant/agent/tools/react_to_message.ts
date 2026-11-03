import { defineTool } from "eve/tools";
import { z } from "zod";
import { updateResult } from "../lib/context.ts";
export default defineTool({
  description: "Set an emoji reaction on the current Telegram message.",
  inputSchema: z.object({ emoji: z.string().min(1).max(32) }),
  execute({ emoji }, ctx) {
    updateResult(ctx, { reaction: emoji });
    return "Reaction prepared.";
  },
});
