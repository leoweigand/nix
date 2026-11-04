import { MAX_BODY, MAX_RESPONSE, type OutboundRequest } from "./egress.ts";

// The caller selects only a public API route; the backend is platform-owned.
export async function fetchInference(
  input: OutboundRequest,
  backend: string,
): Promise<Response> {
  const url = new URL(input.url);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !(
      (input.method === "GET" && url.pathname === "/v1/models") ||
      (input.method === "POST" &&
        ["/v1/chat/completions", "/v1/systemone"].includes(url.pathname))
    )
  )
    throw new Error("Unsupported inference route or method");
  if (
    typeof input.body !== "string" ||
    input.body.length > Math.ceil(MAX_BODY / 3) * 4
  )
    throw new Error("Inference body exceeds 1 MiB");
  const bytes = Buffer.from(input.body, "base64");
  if (bytes.length > MAX_BODY) throw new Error("Inference body exceeds 1 MiB");
  if (input.method === "GET" && bytes.length)
    throw new Error("Model listing cannot have a body");
  if (input.method === "POST") {
    const payload = JSON.parse(bytes.toString("utf8"));
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Inference requires a JSON object");
    if (payload.stream !== undefined && payload.stream !== false)
      throw new Error(
        "Now inference requires stream:false; responses are buffered",
      );
  }
  const signal = AbortSignal.timeout(60_000);
  const response = await fetch(new URL(url.pathname, backend), {
    method: input.method,
    headers: { "content-type": "application/json", accept: "application/json" },
    ...(input.method === "POST" ? { body: bytes } : {}),
    redirect: "error",
    signal,
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  try {
    if (reader)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE)
          throw new Error("Inference response exceeds 2 MiB");
        chunks.push(value);
      }
  } finally {
    await reader?.cancel();
  }
  const headers = new Headers({ "cache-control": "no-store" });
  for (const name of ["content-type", "retry-after"])
    if (response.headers.has(name))
      headers.set(name, response.headers.get(name)!);
  return new Response(
    [204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks),
    {
      status: response.status,
      headers,
    },
  );
}
