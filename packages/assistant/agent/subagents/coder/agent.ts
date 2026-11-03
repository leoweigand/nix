import { defineAgent } from "eve";
import { coderModel } from "../../lib/models.ts";

export default defineAgent({
  description:
    "Write, review and debug code. Give this specialist complete requirements; it cannot see the parent conversation. Continue a task with its taskId.",
  model: coderModel,
  modelContextWindowTokens: 128_000,
  defaultTools: false,
  tool: true,
});
