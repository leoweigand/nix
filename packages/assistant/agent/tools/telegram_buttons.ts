import { defineTool } from "eve/tools";
import { z } from "zod";
import { buttons } from "../lib/presentation.ts";
import { updateResult } from "../lib/context.ts";
export default defineTool({
  description:
    "Attach up to six buttons to the next reply. Choice labels must fully describe the action they authorise.",
  inputSchema: z.object({ buttons: buttons.min(1) }),
  execute(input, ctx) {
    updateResult(ctx, input);
    return "Buttons prepared.";
  },
});
