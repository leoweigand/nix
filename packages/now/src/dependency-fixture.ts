// Explicit online builder qualification; normal package checks remain offline.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { bundle } from "./builder.ts";
const policy = JSON.parse(
  await readFile(process.env.NOW_BUILDER_POLICY!, "utf8"),
);
const source = {
  files: {
    "src/app.ts": `import {DurableObject} from 'cloudflare:workers';import{nanoid}from'nanoid';export class App extends DurableObject{fetch(){return Response.json({id:nanoid()})}}`,
  },
  dependencies: { nanoid: "5.1.6" },
};
const result = await bundle(
  source,
  process.env.NOW_TEST_BUILD_SCRATCH!,
  policy,
);
assert.match(result.code, /nanoid/);
assert.ok(JSON.parse(result.lock!).packages["node_modules/nanoid"]);
console.log(
  JSON.stringify({
    outcome: "passed",
    codeBytes: result.code.length,
    lockedDependency: "nanoid@5.1.6",
  }),
);
