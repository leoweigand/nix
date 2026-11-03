import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const root = process.env.EVE_SANDBOX_ROOT;
const packaged = join(process.env.EVE_CHECK_PACKAGE, "lib/leolab-assistant");
const node = process.env.EVE_CHECK_NODE;
for (const directory of ["tmp", "workflow", "credentials", "supervisor-engine"])
  mkdirSync(join(root, directory), { mode: 0o700 });
const files = readdirSync(join(packaged, "src"))
  .filter((name) => name.endsWith("_test.ts"))
  .sort()
  .map((name) => join(packaged, "src", name));
async function run(command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, `Command failed: ${command}; signal ${signal}`);
}
await run(node, [
  "--import",
  join(root, "eve-sandbox-preload.mjs"),
  "--test",
  "--test-concurrency=1",
  ...files,
]);

const state = join(process.env.EVE_SANDBOX_REQUEST_TMPDIR, "supervisor");
mkdirSync(state, { mode: 0o700 });
const instructions = join(root, "instructions.json");
writeFileSync(
  instructions,
  JSON.stringify({
    system: "Fixture only.",
    channel: "Plain text.",
    channelName: "test",
  }),
);
const env = {
  ...process.env,
  ASSISTANT_RUNTIME: "eve",
  ASSISTANT_STATE_DIR: state,
  ASSISTANT_EVE_STATE_DIR: join(root, "supervisor-engine"),
  ASSISTANT_INSTRUCTIONS_FILE: instructions,
  ASSISTANT_POCKET_ID_SUBJECT: "fixture-owner",
  ASSISTANT_OAUTH_CALLBACK_URL: "https://example.org/callback",
  TELEGRAM_WEBHOOK_SECRET: "sandbox-fixture-secret",
  TELEGRAM_DESTINATIONS: "leo:123",
};
const deniedServer = createServer();
deniedServer.listen(0, "127.0.0.1");
await once(deniedServer, "listening");
const deniedPort = deniedServer.address().port;
await run(
  process.env.EVE_SANDBOX_ENGINE_LAUNCHER,
  [
    node,
    "-e",
    `
const assert = require('node:assert/strict');
const fs = require('node:fs');
assert.throws(() => fs.readFileSync('/etc/passwd'), {code:'EACCES'});
assert.throws(() => fs.writeFileSync(${JSON.stringify(join(root, "outside-approved-state"))}, 'denied'), {code:'EACCES'});
fs.readFileSync(process.env.ASSISTANT_INSTRUCTIONS_FILE);
fetch('http://127.0.0.1:${deniedPort}').then(() => { throw new Error('Unapproved TCP port was reachable'); }, error => assert.equal(error.cause?.code, 'EACCES'));
`,
  ],
  { env },
);
await new Promise((resolve) => deniedServer.close(resolve));
console.log("Landlock denied unapproved reads, writes and TCP connections.");
const worker = spawn(
  process.env.EVE_SANDBOX_ENGINE_LAUNCHER,
  [node, join(packaged, "src/main.ts")],
  { cwd: state, env, stdio: "inherit" },
);
try {
  let healthy = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (worker.exitCode !== null)
      throw new Error(`Supervisor exited ${worker.exitCode}`);
    try {
      const statuses = await Promise.all(
        [
          "http://127.0.0.1:9090/healthz",
          "http://127.0.0.1:9091/internal/healthz",
        ].map(async (url) => (await fetch(url)).status),
      );
      if (statuses.every((status) => status === 204)) {
        healthy = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(
    healthy,
    "Packaged supervisor and Eve must both become healthy under the sandbox",
  );
  worker.kill("SIGTERM");
  const [code] = await once(worker, "exit");
  assert.equal(code, 0);
  await assert.rejects(fetch("http://127.0.0.1:9091/internal/healthz"));
  console.log(
    "Packaged supervisor and Eve health/shutdown checks passed; no Telegram requests sent.",
  );
} finally {
  if (worker.exitCode === null && worker.signalCode === null) {
    worker.kill("SIGKILL");
    await once(worker, "exit");
  }
}
