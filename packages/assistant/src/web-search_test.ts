import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { searchWeb } from "./web-search.ts";

test("web search uses the credential and bounded Lite results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "assistant-exa-"));
  const previous = process.env.CREDENTIALS_DIRECTORY;
  process.env.CREDENTIALS_DIRECTORY = dir;
  try {
    await writeFile(join(dir, "exa-api-key"), "test-key\n");
    const fetcher: typeof fetch = async (url, options) => {
      assert.equal(url, "https://api.exa.ai/search");
      assert.equal(options?.redirect, "error");
      assert.equal(new Headers(options?.headers).get("x-api-key"), "test-key");
      assert.deepEqual(JSON.parse(String(options?.body)), {
        query: "latest news",
        type: "lite",
        numResults: 5,
        contents: { highlights: true },
      });
      return Response.json({
        results: [
          {
            url: "https://example.com",
            title: "Example",
            highlights: ["Useful text"],
            secret: "ignore",
          },
          { url: "javascript:bad" },
        ],
      });
    };
    assert.deepEqual(await searchWeb("latest news", fetcher), [
      {
        url: "https://example.com",
        title: "Example",
        publishedDate: undefined,
        highlights: ["Useful text"],
      },
    ]);
    await assert.rejects(
      searchWeb("test", async () => new Response("secret", { status: 401 })),
      /HTTP 401/,
    );
  } finally {
    if (previous === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
