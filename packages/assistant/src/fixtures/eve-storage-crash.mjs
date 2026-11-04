// Executed only by eve-local-world_test.ts in a disposable fixture directory.
import fs from "node:fs/promises";
import { join } from "node:path";
const [directory, boundary, outcome, runId] = process.argv.slice(2);
const stepId = "step_01M6H4HJX6EWC5872SH9EV50K0";
const isRun = outcome.startsWith("run_");
const marker = isRun
  ? join(directory, ".locks", "runs", `${runId}.terminal`)
  : join(directory, ".locks", "steps", `${runId}-${stepId}.terminal`);
const crash = () => process.kill(process.pid, "SIGKILL");
const open = fs.open;
fs.open = async (...args) => {
  const file = await open(...args);
  const path = String(args[0]);
  if (path.startsWith(`${marker}.wal-tmp-`)) {
    const write = file.writeFile.bind(file);
    file.writeFile = async (contents, ...rest) => {
      if (contents && boundary === "partial-journal") {
        await write(String(contents).slice(0, 10), ...rest);
        crash();
      }
      return write(contents, ...rest);
    };
    const sync = file.sync.bind(file);
    file.sync = async () => {
      await sync();
      if (boundary === "journal-synced" && (await file.stat()).size > 0)
        crash();
    };
  }
  return file;
};
const link = fs.link;
fs.link = async (...args) => {
  await link(...args);
  const path = String(args[1]);
  if (path === marker && boundary === "marker-published") crash();
  if (boundary === "event-published" && path.includes("/events/")) {
    const event = JSON.parse(await fs.readFile(path, "utf8"));
    if (
      event.eventType === outcome &&
      (isRun || event.correlationId === stepId)
    )
      crash();
  }
};
const rename = fs.rename;
fs.rename = async (...args) => {
  await rename(...args);
  const path = String(args[1]);
  if (
    boundary === "checkpoint-published" &&
    (isRun
      ? path.endsWith(`/runs/${runId}.json`)
      : path.includes(`/steps/${runId}/`))
  )
    crash();
  if (boundary === "marker-compacted" && path === marker) crash();
};
const { createWorld } = await import(
  new URL(
    "./compiled/@workflow/world-local/index.js",
    import.meta.resolve("eve"),
  )
);
const world = createWorld({ dataDir: directory, recoverActiveRuns: false });
await world.start();
await world.events.create(runId, {
  eventType: outcome,
  ...(isRun ? {} : { correlationId: stepId }),
  specVersion: 8,
  eventData: outcome.endsWith("completed")
    ? { [isRun ? "output" : "result"]: new Uint8Array([42]) }
    : outcome.endsWith("failed")
      ? { error: new Uint8Array([43]) }
      : undefined,
});
throw new Error(`Crash boundary was not reached: ${boundary}`);
