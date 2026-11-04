import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Deliberately exercises the exact world bundled with our pinned Eve release.
// No engine build, model, HTTP transport or integration code is involved.
const worldModule = new URL(
  "./compiled/@workflow/world-local/index.js",
  import.meta.resolve("eve"),
);

// The runtime rejects run IDs older than a day. Keep the crash fixtures current.
function freshRunId() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let timestamp = BigInt(Date.now());
  let prefix = "";
  for (let index = 0; index < 10; index++) {
    prefix = alphabet[Number(timestamp & 31n)] + prefix;
    timestamp >>= 5n;
  }
  return `wrun_${prefix}WMP6780AMKKEZT4B`;
}

test("Eve local world can finish a step after an interrupted terminal checkpoint", async () => {
  const { createWorld } = await import(worldModule.href);
  const directory = mkdtempSync(join(tmpdir(), "eve-storage-crash-"));
  const runId = freshRunId();
  const stepId = "step_01M6H4HJX6EWC5872SH9EV50K0";
  const options = { dataDir: directory, recoverActiveRuns: false };
  let world = createWorld(options);
  const rename = fs.rename;
  try {
    await world.start();
    const event = (eventType: string, eventData?: unknown, step = false) =>
      world.events.create(runId, {
        eventType,
        specVersion: 8,
        ...(eventData ? { eventData } : {}),
        ...(step ? { correlationId: stepId } : {}),
      });
    await event("run_created", {
      deploymentId: "dpl_local@5.1.2",
      workflowName: "workflow//fixture",
      input: new Uint8Array(),
    });
    await event("run_started");
    await event(
      "step_created",
      { stepName: "step//fixture", input: new Uint8Array() },
      true,
    );
    await event("step_started", {}, true);

    // Interrupt exactly between claiming terminal state and publishing the
    // checkpoint. This deterministically reproduces the observed SIGTERM
    // window without relying on a scheduler race or artificial settling delay.
    fs.rename = async (...args: Parameters<typeof fs.rename>) => {
      if (String(args[1]).includes(stepId))
        throw new Error("injected checkpoint interruption");
      return rename(...args);
    };
    await assert.rejects(
      event("step_completed", { result: new Uint8Array([42]) }, true),
      /injected checkpoint interruption/,
    );
    fs.rename = rename;
    await world.close();
    world = createWorld(options);
    await world.start();
    if ((await world.steps.get(runId, stepId)).status !== "completed")
      await event("step_completed", { result: new Uint8Array([42]) }, true);
    assert.equal((await world.steps.get(runId, stepId)).status, "completed");
    const events = await world.events.list({ runId });
    assert.ok(
      events.data.some(
        (entry: { eventType: string; correlationId?: string }) =>
          entry.eventType === "step_completed" &&
          entry.correlationId === stepId,
      ),
    );
  } finally {
    fs.rename = rename;
    await world.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const outcome of [
  "step_completed",
  "step_failed",
  "run_completed",
  "run_failed",
  "run_cancelled",
])
  for (const boundary of [
    "partial-journal",
    "journal-synced",
    "marker-published",
    "checkpoint-published",
    "event-published",
    "marker-compacted",
    "recovery-checkpoint-published",
    "recovery-event-published",
    "recovery-marker-compacted",
  ])
    test(`terminal ${outcome} survives SIGKILL at ${boundary}`, async () => {
      const { spawn } = await import("node:child_process");
      const { once } = await import("node:events");
      const { fileURLToPath } = await import("node:url");
      const { createWorld } = await import(worldModule.href);
      const directory = mkdtempSync(join(tmpdir(), "eve-terminal-crash-"));
      const runId = freshRunId();
      const stepId = "step_01M6H4HJX6EWC5872SH9EV50K0";
      const isRun = outcome.startsWith("run_");
      const terminal = {
        eventType: outcome,
        ...(isRun ? {} : { correlationId: stepId }),
        specVersion: 8,
        eventData: outcome.endsWith("completed")
          ? { [isRun ? "output" : "result"]: new Uint8Array([42]) }
          : outcome.endsWith("failed")
            ? { error: new Uint8Array([43]) }
            : undefined,
      };
      const options = { dataDir: directory, recoverActiveRuns: false };
      let world = createWorld(options);
      const entity = () =>
        isRun ? world.runs.get(runId) : world.steps.get(runId, stepId);
      try {
        await world.start();
        for (const event of [
          {
            eventType: "run_created",
            eventData: {
              deploymentId: "dpl_local@5.1.2",
              workflowName: "workflow//fixture",
              input: new Uint8Array(),
            },
          },
          { eventType: "run_started" },
          {
            eventType: "step_created",
            correlationId: stepId,
            eventData: { stepName: "step//fixture", input: new Uint8Array() },
          },
          { eventType: "step_started", correlationId: stepId },
        ])
          await world.events.create(runId, { ...event, specVersion: 8 });
        await world.close();
        const crashAt = async (point: string) => {
          const child = spawn(
            process.execPath,
            [
              fileURLToPath(
                new URL("fixtures/eve-storage-crash.mjs", import.meta.url),
              ),
              directory,
              point,
              outcome,
              runId,
            ],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          let logs = "";
          child.stderr.on("data", (chunk) => (logs += chunk));
          const [code, signal] = await once(child, "exit");
          assert.equal(code, null, logs);
          assert.equal(signal, "SIGKILL", logs);
        };
        await crashAt(
          boundary.startsWith("recovery-") ? "marker-published" : boundary,
        );
        if (boundary.startsWith("recovery-")) await crashAt(boundary.slice(9));
        const before = await world.events.list({ runId });
        const priorEvent = before.data.find(
          (event: { eventType: string; correlationId?: string }) =>
            event.eventType === outcome &&
            (isRun || event.correlationId === stepId),
        );
        world = createWorld(options);
        await world.start();
        const expected = outcome.slice(isRun ? 4 : 5);
        if (["partial-journal", "journal-synced"].includes(boundary)) {
          // No redo record was claimed. The step remains eligible for retry;
          // mutating tools independently use the assistant's durable receipts.
          assert.equal((await entity()).status, "running");
          await world.events.create(runId, terminal);
        }
        assert.equal((await entity()).status, expected);
        for (let restart = 0; restart < 2; restart++) {
          await world.close();
          world = createWorld(options);
          await world.start();
          const events = (await world.events.list({ runId })).data.filter(
            (event: { eventType: string; correlationId?: string }) =>
              event.eventType === outcome &&
              (isRun || event.correlationId === stepId),
          );
          assert.equal(
            events.length,
            1,
            "Recovery must not duplicate terminal events",
          );
          if (priorEvent) assert.equal(events[0].eventId, priorEvent.eventId);
          const step = await entity();
          if (outcome !== "run_cancelled")
            assert.deepEqual(
              outcome.endsWith("completed") ? step.output : step.error,
              new Uint8Array([outcome.endsWith("completed") ? 42 : 43]),
            );
        }
      } finally {
        await world.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });

for (const kind of ["steps", "runs"])
  for (const legacyState of ["running", "completed", "malformed-journal"])
    test(`recovery preserves uncertain ${kind} ${legacyState} terminal state`, async () => {
      const { createWorld } = await import(worldModule.href);
      const directory = mkdtempSync(join(tmpdir(), "eve-legacy-terminal-"));
      const runId = freshRunId();
      const stepId = "step_01M6H4HJX6EWC5872SH9EV50K0";
      const options = { dataDir: directory, recoverActiveRuns: false };
      let world = createWorld(options);
      try {
        await world.start();
        await world.events.create(runId, {
          eventType: "run_created",
          specVersion: 8,
          eventData: {
            deploymentId: "dpl_local@5.1.2",
            workflowName: "workflow//fixture",
            input: new Uint8Array(),
          },
        });
        await world.events.create(runId, {
          eventType: "step_created",
          correlationId: stepId,
          specVersion: 8,
          eventData: { stepName: "step//fixture", input: new Uint8Array() },
        });
        const checkpoint =
          kind === "runs"
            ? join(directory, "runs", `${runId}.json`)
            : join(directory, "steps", runId, `${runId}-${stepId}.json`);
        const data = JSON.parse(await fs.readFile(checkpoint, "utf8"));
        data.status = legacyState === "completed" ? "completed" : "running";
        await fs.writeFile(checkpoint, JSON.stringify(data));
        await fs.mkdir(join(directory, ".locks", kind), { recursive: true });
        const marker =
          kind === "runs"
            ? join(directory, ".locks", kind, `${runId}.terminal`)
            : join(directory, ".locks", kind, `${runId}-${stepId}.terminal`);
        const contents = legacyState === "malformed-journal" ? "{partial" : "";
        await fs.writeFile(marker, contents);
        await world.close();
        world = createWorld(options);
        await assert.rejects(world.start());
        assert.equal(await fs.readFile(marker, "utf8"), contents);
        assert.deepEqual(
          JSON.parse(await fs.readFile(checkpoint, "utf8")),
          data,
        );
      } finally {
        await world.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
