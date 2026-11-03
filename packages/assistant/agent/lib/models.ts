import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const gateway = createOpenAICompatible({
  name: "leolab",
  baseURL:
    process.env.ASSISTANT_AI_URL ?? "https://ai.internal.leolab.party/v1",
  apiKey: "internal-gateway",
});
export const assistantModel = gateway.chatModel("claude-haiku-5-5");
export const coderModel = gateway.chatModel("deepseek-v4.1-flash");
