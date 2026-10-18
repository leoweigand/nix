import { readFile } from "node:fs/promises";
import { createWebServer } from "../../runtime/http.ts";
import { restrictedFetch } from "../../runtime/network.ts";

export interface ModelPolicy {
  chatModels: string[];
  defaultChatModel: string;
  systemoneModels: string[];
  defaultSystemoneModel: string;
}
export interface GatewayConfig extends ModelPolicy {
  apiKey: string;
  maxBodyBytes: number;
  maxConcurrent: number;
  timeoutMs: number;
}
interface Dependencies {
  fetch: typeof fetch;
  log: Pick<Console, "info">;
}
const upstreamFetch = restrictedFetch(["https://opencode.ai"]);

function error(status: number, message: string, code: string): Response {
  return Response.json(
    { error: { message, type: "invalid_request_error", code } },
    { status },
  );
}

export function createHandler(
  config: GatewayConfig,
  dependencies: Dependencies = { fetch: upstreamFetch, log: console },
): (request: Request) => Promise<Response> {
  for (const [models, defaultModel] of [
    [config.chatModels, config.defaultChatModel],
    [config.systemoneModels, config.defaultSystemoneModel],
  ] as const) {
    if (!models.includes(defaultModel) || models.includes("default"))
      throw new Error("Default model must belong to its protocol allowlist");
  }
  let active = 0;
  return async (request) => {
    const url = new URL(request.url);
    if (url.search)
      return error(400, "Query parameters are unsupported", "invalid_query");
    if (url.pathname === "/healthz")
      return request.method === "GET"
        ? new Response(null, { status: 204 })
        : error(405, "Use GET", "method_not_allowed");
    if (url.pathname === "/v1/models") {
      if (request.method !== "GET")
        return error(405, "Use GET", "method_not_allowed");
      return Response.json({
        object: "list",
        data: [
          ...new Set([...config.chatModels, ...config.systemoneModels]),
        ].map((id) => ({
          id,
          object: "model",
          created: 0,
          owned_by: "opencode",
        })),
      });
    }
    const chat = url.pathname === "/v1/chat/completions";
    if (!chat && url.pathname !== "/v1/systemone")
      return error(404, "Unknown endpoint", "not_found");
    if (request.method !== "POST")
      return error(405, "Use POST", "method_not_allowed");
    if (
      request.headers.get("content-type")?.split(";")[0].trim() !==
      "application/json"
    )
      return error(415, "Use application/json", "unsupported_media_type");
    if (request.headers.has("content-encoding"))
      return error(
        415,
        "Encoded request bodies are unsupported",
        "unsupported_media_type",
      );
    if (active >= config.maxConcurrent)
      return new Response(
        JSON.stringify({
          error: { message: "Gateway is busy", code: "concurrency_limit" },
        }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "1" },
        },
      );
    active++;
    const started = Date.now();
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    let model: string | undefined;
    let status = 500;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(timer);
      request.signal.removeEventListener("abort", abort);
      active--;
      dependencies.log.info(
        JSON.stringify({
          event: "ai_request",
          endpoint: url.pathname,
          model,
          status,
          duration_ms: Date.now() - started,
          cancelled: controller.signal.aborted,
        }),
      );
    };
    let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelBody = () => {
      void bodyReader?.cancel().catch(() => {});
    };
    controller.signal.addEventListener("abort", cancelBody, { once: true });
    const fail = (response: Response) => {
      status = response.status;
      release();
      return response;
    };
    try {
      if (Number(request.headers.get("content-length")) > config.maxBodyBytes)
        return fail(
          error(413, "Request body exceeds gateway limit", "body_too_large"),
        );
      bodyReader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (bodyReader) {
        const { done, value } = await bodyReader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > config.maxBodyBytes) {
          await bodyReader.cancel();
          return fail(
            error(413, "Request body exceeds gateway limit", "body_too_large"),
          );
        }
        chunks.push(value);
      }
      if (controller.signal.aborted) throw new Error("aborted");
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          throw new Error("object required");
      } catch {
        return fail(error(400, "Body must be a JSON object", "invalid_json"));
      }
      const allowed = chat ? config.chatModels : config.systemoneModels;
      const selected =
        payload.model === undefined || payload.model === "default"
          ? chat
            ? config.defaultChatModel
            : config.defaultSystemoneModel
          : payload.model;
      if (typeof selected !== "string" || !allowed.includes(selected))
        return fail(
          error(
            400,
            "Model is not allowed for this endpoint",
            "model_not_allowed",
          ),
        );
      model = selected;
      payload.model = model;
      const upstream = await dependencies.fetch(
        `https://opencode.ai/inference/${chat ? "openai/v1/chat/completions" : "systemone/v1/systemone"}`,
        {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
            "accept-encoding": "identity",
            accept: request.headers.get("accept") ?? "application/json",
          },
          body: JSON.stringify(payload),
        },
      );
      status = upstream.status;
      // Redirects could replay paid requests or expose credentials; never follow them.
      if (status >= 300 && status < 400) {
        await upstream.body?.cancel();
        return fail(
          error(502, "Upstream redirect refused", "upstream_redirect"),
        );
      }
      const headers = new Headers({ "cache-control": "no-store" });
      for (const name of [
        "content-type",
        "retry-after",
        "x-request-id",
        "request-id",
        "x-ratelimit-limit-requests",
        "x-ratelimit-remaining-requests",
        "x-ratelimit-reset-requests",
      ])
        if (upstream.headers.has(name))
          headers.set(name, upstream.headers.get(name)!);
      if (!upstream.body) {
        release();
        return new Response(null, { status, headers });
      }
      const reader = upstream.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(output) {
          try {
            const next = await reader.read();
            if (next.done) {
              release();
              output.close();
            } else output.enqueue(next.value);
          } catch {
            release();
            output.error(new Error("Upstream response interrupted"));
          }
        },
        async cancel() {
          controller.abort();
          try {
            await reader.cancel();
          } finally {
            release();
          }
        },
      });
      return new Response(stream, { status, headers });
    } catch {
      return fail(
        error(
          timedOut ? 504 : 502,
          timedOut ? "Gateway request timed out" : "Upstream request failed",
          timedOut ? "gateway_timeout" : "upstream_error",
        ),
      );
    } finally {
      controller.signal.removeEventListener("abort", cancelBody);
    }
  };
}

if (import.meta.main) {
  const policy = JSON.parse(
    await readFile(process.env["AI_GATEWAY_CONFIG"]!, "utf8"),
  );
  const apiKey = (
    await readFile(`${process.env["CREDENTIALS_DIRECTORY"]}/api-key`, "utf8")
  ).trim();
  if (!apiKey || /[\r\n]/.test(apiKey))
    throw new Error("Invalid upstream API key");
  createWebServer(createHandler({ ...policy, apiKey })).listen(
    policy.port,
    "127.0.0.1",
  );
}
