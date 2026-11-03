import { defineTool } from "eve/tools";
import { z } from "zod";
import { buttons } from "../lib/presentation.ts";
import { updateResult } from "../lib/context.ts";
import { cardMarkdown } from "../../src/replies.ts";
export default defineTool({
  description:
    "Prepare the complete answer as up to six Telegram result cards with rich Markdown, optional public MCP posters and per-result buttons. Replaces the final text reply.",
  inputSchema: z.object({
    cards: z
      .array(
        z.object({
          text: z.string().min(1).max(3000),
          poster: z.string().max(2048).optional(),
          buttons: buttons.optional(),
        }),
      )
      .min(1)
      .max(6),
  }),
  execute(input, ctx) {
    input.cards.forEach(cardMarkdown);
    updateResult(ctx, input);
    return "Complete answer prepared; finish the turn.";
  },
});
