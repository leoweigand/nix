import { defineTool } from "eve/tools";
import { z } from "zod";
import { updateResult } from "../lib/context.ts";
export default defineTool({
  description:
    "Request a private Pocket ID sign-in link and resume this request after connection. Stop here after calling.",
  inputSchema: z.object({}),
  endsTurn: true,
  execute(_input, ctx) {
    updateResult(ctx, { needsConnection: true });
    return "The host will send a private sign-in link.";
  },
});
