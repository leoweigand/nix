// Local-world 5.1.2 terminal-step transaction repair. Installed by patch-eve.ts.
// The local world supports one process per state directory. Recovery runs before
// its queue starts; step transitions are already serialised within that process.
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

async function sync(path) {
  const file = await fs.open(path, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

async function durableTemporary(path, contents) {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.wal-tmp-${randomUUID()}`;
  const file = await fs.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents);
    await file.sync();
  } finally {
    await file.close();
  }
  return temporary;
}

export async function claimTerminal(path, contents) {
  const temporary = await durableTemporary(path, contents);
  try {
    try {
      await fs.link(temporary, path);
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
    await sync(dirname(path));
    return true;
  } finally {
    await fs.unlink(temporary).catch(() => {});
  }
}

export async function finishTerminal(marker, checkpoint, event) {
  // Do not discard the redo record until both published files and directory
  // entries are durable. A crash during compaction can leave either marker.
  await sync(checkpoint);
  await sync(dirname(checkpoint));
  await sync(event);
  await sync(dirname(event));
  await compactTerminal(marker);
}

async function compactTerminal(marker) {
  const temporary = await durableTemporary(marker, "");
  await fs.rename(temporary, marker);
  await sync(dirname(marker));
}

export async function recoverTerminals(directory, tag, callbacks) {
  const markers = join(directory, ".locks", "steps");
  let names;
  try {
    names = await fs.readdir(markers);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const suffix = tag ? `.terminal.${tag}` : ".terminal";
  for (const name of names.filter((name) => name.endsWith(suffix))) {
    const marker = join(markers, name);
    const key = name.slice(0, -suffix.length);
    const split = key.indexOf("-step_");
    if (split === -1) throw new Error(`Invalid terminal marker: ${name}`);
    const runId = key.slice(0, split);
    const stepId = key.slice(split + 1);
    const contents = await fs.readFile(marker, "utf8");
    const record = contents ? callbacks.parse(contents) : undefined;
    const existing = await callbacks.findEvent(runId, stepId);
    if (!record) {
      const step = await callbacks.readStep(runId, stepId);
      const run = await callbacks.readRun(runId);
      // Retention may have removed the run and its steps; never resurrect them.
      if (!run || ["completed", "failed", "cancelled"].includes(run.status))
        continue;
      if (!step || !["completed", "failed"].includes(step.status) || !existing)
        throw new Error(
          `Unrecoverable legacy terminal marker for ${runId}/${stepId}; preserve the state for investigation`,
        );
      continue;
    }
    if (
      record.version !== 1 ||
      record.step?.runId !== runId ||
      record.step?.stepId !== stepId ||
      record.event?.runId !== runId ||
      record.event?.correlationId !== stepId ||
      !["step_completed", "step_failed"].includes(record.event.eventType) ||
      record.step.status !== record.event.eventType.slice(5)
    )
      throw new Error(`Invalid terminal journal: ${marker}`);
    const run = await callbacks.readRun(runId);
    if (!run || run.expiredAt) {
      // Data retention or explicit deletion wins over a pending step result.
      await compactTerminal(marker);
      continue;
    }
    if (existing && existing.eventType !== record.event.eventType)
      throw new Error(`Conflicting terminal event for ${runId}/${stepId}`);
    const checkpoint = await callbacks.writeStep(record.step);
    // Event slots may have advanced before the crash. Find the already-published
    // event by step identity first, preserving its ID and avoiding duplicates.
    const event = existing ?? (await callbacks.appendEvent(record.event));
    await finishTerminal(marker, checkpoint, callbacks.eventPath(event));
  }
  // An unlinked temporary record was never accepted. Only the owning process
  // uses this directory, so interrupted pre-publication writes can be removed.
  for (const name of names.filter((name) =>
    name.includes(`${suffix}.wal-tmp-`),
  ))
    await fs.unlink(join(markers, name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
}

export async function recoverRunTerminals(directory, tag, callbacks) {
  const markers = join(directory, ".locks", "runs");
  const names = await fs.readdir(markers).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const suffix = tag ? `.terminal.${tag}` : ".terminal";
  for (const name of names.filter((name) => name.endsWith(suffix))) {
    const marker = join(markers, name);
    const runId = name.slice(0, -suffix.length);
    const contents = await fs.readFile(marker, "utf8");
    const record = contents ? callbacks.parse(contents) : undefined;
    const existing = await callbacks.findRunEvent(runId);
    const run = await callbacks.readRun(runId);
    if (!record) {
      if (!run) continue;
      if (
        !["completed", "failed", "cancelled"].includes(run.status) ||
        !existing
      )
        throw new Error(
          `Unrecoverable legacy terminal marker for ${runId}; preserve the state for investigation`,
        );
      continue;
    }
    if (
      record.version !== 1 ||
      record.previousRun?.runId !== runId ||
      record.event?.runId !== runId ||
      !["run_completed", "run_failed", "run_cancelled"].includes(
        record.event.eventType,
      )
    )
      throw new Error(`Invalid terminal journal: ${marker}`);
    if (!run) throw new Error(`Missing run for terminal journal: ${runId}`);
    if (existing && existing.eventType !== record.event.eventType)
      throw new Error(`Conflicting terminal event for ${runId}`);
    const { checkpoint, purged } = await callbacks.writeRun(record);
    const event = existing ?? (await callbacks.appendRunEvent(record.event));
    if (purged) await callbacks.purgeRun(runId);
    await finishTerminal(marker, checkpoint, callbacks.eventPath(event));
  }
  for (const name of names.filter((name) =>
    name.includes(`${suffix}.wal-tmp-`),
  ))
    await fs.unlink(join(markers, name)).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
}
