import { AsyncLocalStorage } from "node:async_hooks";
import { createOpenAIOAuthFetchHandler } from "openai-oauth";
import { restrictedFetch } from "../../runtime/network.ts";

export interface OpenAIProvider {
  models(signal: AbortSignal): Promise<string[]>;
  handle(request: Request): Promise<Response>;
}

export function createOpenAIProvider(
  authFilePath: string,
  allowedModels: string[] | null,
  transport: typeof fetch = restrictedFetch([
    "https://chatgpt.com",
    "https://auth.openai.com",
    "https://registry.npmjs.org",
  ]),
): OpenAIProvider {
  // Bind metadata lookup and token refresh to the same deadline as inference.
  const context = new AsyncLocalStorage<AbortSignal>();
  const handler = createOpenAIOAuthFetchHandler({
    authFilePath,
    requestLogger() {},
    fetch: (input, init) => {
      const signal = context.getStore();
      return transport(input, {
        ...init,
        redirect: "error",
        ...(signal
          ? {
              signal: init?.signal
                ? AbortSignal.any([signal, init.signal])
                : signal,
            }
          : {}),
      });
    },
  });
  let cached: { models: string[]; expires: number } | undefined;
  return {
    async models(signal) {
      if (cached && cached.expires > Date.now()) return cached.models;
      const response = await context.run(signal, () =>
        handler(new Request("http://localhost/v1/models", { signal })),
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("OpenAI model discovery unavailable");
      }
      const body = (await response.json()) as {
        data: { id: string }[];
      };
      const models = body.data
        .map((model) => model.id)
        .filter((id) => id !== "default" && !id.startsWith("gpt-image-"))
        .filter((id) => allowedModels === null || allowedModels.includes(id));
      cached = { models, expires: Date.now() + 5 * 60_000 };
      return models;
    },
    handle: (request) => context.run(request.signal, () => handler(request)),
  };
}
