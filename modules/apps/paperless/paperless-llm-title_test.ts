import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanTitle, isAutoTitle } from "./paperless-llm-title.ts";

test("auto-title detection preserves user-provided titles", () => {
  assert.equal(isAutoTitle("2026-09-21 scan", undefined), true);
  assert.equal(isAutoTitle("IMG_1234", undefined), true);
  assert.equal(isAutoTitle("invoice-2026", "invoice-2026.pdf"), true);
  assert.equal(
    isAutoTitle("Electricity bill — September 2026", "scan.pdf"),
    false,
  );
});

test("LLM titles are normalized before being stored", () => {
  assert.equal(
    cleanTitle('  "Electricity bill — September 2026."  '),
    "Electricity bill — September 2026",
  );
  assert.equal(cleanTitle("'Mietvertrag'"), "Mietvertrag");
});

// Exercise the complete hook without contacting Paperless or OpenAI.
test("post-consume hook reads secrets, generates a title and updates the document", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { mock } = await import("node:test");
  const directory = await mkdtemp(join(tmpdir(), "paperless-title-"));
  t.after(async () => {
    mock.restoreAll();
    await rm(directory, { recursive: true });
  });
  const passwordFile = join(directory, "password");
  const keyFile = join(directory, "openai-key");
  await writeFile(passwordFile, "test-password\n");
  await writeFile(keyFile, "test-key\n");
  let patched: unknown;
  mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const request = input as Request;
    const url = new URL(request.url);
    if (url.pathname === "/api/token/") {
      assert.deepEqual(await request.json(), {
        username: "admin",
        password: "test-password",
      });
      return Response.json({ token: "test-token" });
    }
    if (request.method === "GET")
      return Response.json({
        title: "IMG_1234",
        original_file_name: "IMG_1234.pdf",
        content: "Electricity invoice details. ".repeat(10),
      });
    if (url.hostname === "api.openai.com") {
      assert.equal(request.headers.get("authorization"), "Bearer test-key");
      return Response.json({
        choices: [{ message: { content: "Electricity invoice" } }],
      });
    }
    assert.equal(request.method, "PATCH");
    assert.equal(url.pathname, "/api/documents/123/");
    assert.equal(request.headers.get("authorization"), "Token test-token");
    patched = await request.json();
    return Response.json({});
  });
  // A fresh module captures the mocked transport rather than the earlier unit-test import.
  const { main } = await import(
    new URL("./paperless-llm-title.ts?integration", import.meta.url).href
  );
  assert.equal(
    await main({
      DOCUMENT_ID: "123",
      PAPERLESS_LLM_API_PASSWORD_FILE: passwordFile,
      PAPERLESS_LLM_OPENAI_KEY_FILE: keyFile,
    }),
    0,
  );
  assert.deepEqual(patched, { title: "Electricity invoice" });
});
