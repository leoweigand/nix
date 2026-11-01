import { readFile } from "node:fs/promises";
import { join } from "node:path";

export async function searchWeb(query: string, fetcher: typeof fetch = fetch) {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  if (!dir) throw new Error("Web search credential unavailable");
  const key = (await readFile(join(dir, "exa-api-key"), "utf8")).trim();
  if (!key) throw new Error("Web search credential unavailable");
  const response = await fetcher("https://api.exa.ai/search", {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(25000),
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({
      query,
      type: "lite",
      numResults: 5,
      contents: { highlights: true },
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Web search failed (HTTP ${response.status})`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Web search returned no response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256_000) throw new Error("Web search response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !data ||
    typeof data !== "object" ||
    !("results" in data) ||
    !Array.isArray(data.results)
  )
    throw new Error("Web search returned an invalid response");
  return data.results.slice(0, 5).flatMap((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      !("url" in item) ||
      typeof item.url !== "string"
    )
      return [];
    if (
      !URL.canParse(item.url) ||
      !["http:", "https:"].includes(new URL(item.url).protocol)
    )
      return [];
    const field = (name: string, limit: number) =>
      name in item && typeof item[name as keyof typeof item] === "string"
        ? (item[name as keyof typeof item] as string).slice(0, limit)
        : undefined;
    const highlights =
      "highlights" in item && Array.isArray(item.highlights)
        ? item.highlights
            .filter((v: unknown): v is string => typeof v === "string")
            .slice(0, 4)
            .map((v: string) => v.slice(0, 1500))
        : [];
    return [
      {
        url: item.url.slice(0, 2048),
        title: field("title", 300),
        publishedDate: field("publishedDate", 40),
        highlights,
      },
    ];
  });
}
