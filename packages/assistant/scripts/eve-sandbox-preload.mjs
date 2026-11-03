// Verification only: wrap the immutable package's engine children in Landlock.
import childProcess from "node:child_process";
import fs from "node:fs";
import { basename, join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (
    command === process.execPath &&
    args?.some((arg) => arg.endsWith("/.output/server/index.mjs"))
  ) {
    const env = options.env;
    return spawn(process.env.EVE_SANDBOX_ENGINE_LAUNCHER, [command, ...args], {
      ...options,
      env: {
        ...env,
        EVE_SANDBOX_ENGINE_PORT: env.PORT,
        EVE_SANDBOX_FIXTURE_PORT: new URL(env.ASSISTANT_AI_URL).port,
      },
    });
  }
  return spawn(command, args, options);
};
const mkdtempSync = fs.mkdtempSync;
fs.mkdtempSync = (prefix, ...options) => {
  if (
    typeof prefix === "string" &&
    ["eve-mcp-", "eve-integration-"].includes(basename(prefix))
  )
    prefix = join(process.env.EVE_SANDBOX_REQUEST_TMPDIR, basename(prefix));
  return mkdtempSync(prefix, ...options);
};
syncBuiltinESMExports();
