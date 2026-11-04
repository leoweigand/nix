import { defineTool } from "eve/tools";
import { z } from "zod";
import { updateResult } from "../lib/context.ts";
export default defineTool({
  description:
    "React to the current Telegram message when an emoji is enough as the whole response, or to acknowledge it before continuing work. Typing already indicates progress.",
  inputSchema: z.object({
    emoji: z.string().min(1).max(32),
    reactionOnly: z
      .boolean()
      .default(true)
      .describe(
        "Use true for a reaction instead of text; false to acknowledge before continuing work and answering.",
      ),
  }),
  execute({ emoji, reactionOnly }, ctx) {
    updateResult(ctx, { reaction: emoji, reactionOnly });
    return "Reaction prepared.";
  },
});
