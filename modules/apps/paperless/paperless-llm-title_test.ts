import assert from "node:assert/strict";
import { cleanTitle, isAutoTitle } from "./paperless-llm-title.ts";

Deno.test("auto-title detection preserves user-provided titles", () => {
  assert.equal(isAutoTitle("2026-09-21 scan", undefined), true);
  assert.equal(isAutoTitle("IMG_1234", undefined), true);
  assert.equal(isAutoTitle("invoice-2026", "invoice-2026.pdf"), true);
  assert.equal(
    isAutoTitle("Electricity bill — September 2026", "scan.pdf"),
    false,
  );
});

Deno.test("LLM titles are normalized before being stored", () => {
  assert.equal(
    cleanTitle('  "Electricity bill — September 2026."  '),
    "Electricity bill — September 2026",
  );
  assert.equal(cleanTitle("'Mietvertrag'"), "Mietvertrag");
});
