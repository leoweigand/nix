import { defineAgent } from "eve";
import { assistantModel } from "./lib/models.ts";

export default defineAgent({
  model: assistantModel,
  modelContextWindowTokens: 1_000_000,
  defaultTools: false,
  tool: false,
  limits: { sessionTimeoutMs: 24 * 60 * 60_000 },
});
