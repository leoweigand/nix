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

test(
  "Eve local world can finish a step after an interrupted terminal checkpoint",
  { skip: process.env.EVE_STORAGE_CRASH_TEST !== "1" },
  async () => {
    const { createWorld } = await import(worldModule.href);
    const directory = mkdtempSync(join(tmpdir(), "eve-storage-crash-"));
    const runId = "wrun_01M6H4HJX6WMP6780AMKKEZT4B";
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
  },
);
