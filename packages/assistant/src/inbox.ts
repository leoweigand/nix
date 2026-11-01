import { timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";

export interface Job {
  id: number;
  chatId: string;
  senderId: string;
  destination: string;
  text: string;
  messageId: number;
  topicId?: number;
  reply?: string;
  done?: boolean;
}
export interface Policy {
  ownerId: string;
  destinations: Map<string, string>;
  botUsername?: string;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function eligibleJob(update: unknown, policy: Policy): Job | undefined {
  if (
    !record(update) ||
    !Number.isSafeInteger(update.update_id) ||
    (update.update_id as number) < 0 ||
    !record(update.message)
  )
    return;
  const m = update.message;
  if (
    !record(m.chat) ||
    !record(m.from) ||
    m.from.is_bot ||
    m.sender_chat ||
    String(m.from.id) !== policy.ownerId ||
    typeof m.text !== "string" ||
    !m.text.trim() ||
    m.text.length > 8000 ||
    !Number.isSafeInteger(m.message_id)
  )
    return;
  const chatId = String(m.chat.id);
  const destination = [...policy.destinations].find(
    ([, id]) => id === chatId,
  )?.[0];
  if (!destination) return;
  if (m.chat.type === "private") {
    if (chatId !== policy.ownerId) return;
  } else if (m.chat.type === "group" || m.chat.type === "supergroup") {
    if (
      !policy.botUsername ||
      !Array.isArray(m.entities) ||
      !m.entities.some(
        (e) =>
          record(e) &&
          e.type === "mention" &&
          typeof e.offset === "number" &&
          typeof e.length === "number" &&
          m
            .text!.toString()
            .slice(e.offset, e.offset + e.length)
            .toLowerCase() === `@${policy.botUsername!.toLowerCase()}`,
      )
    )
      return;
  } else return;
  return {
    id: update.update_id as number,
    chatId,
    senderId: policy.ownerId,
    destination,
    text: m.text,
    messageId: m.message_id as number,
    ...(Number.isSafeInteger(m.message_thread_id)
      ? { topicId: m.message_thread_id as number }
      : {}),
  };
}
export function authorized(actual: string | null, expected: string): boolean {
  if (!actual || !expected) return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class Inbox {
  directory: string;
  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  file(id: number) {
    return join(this.directory, `${id}.json`);
  }
  save(job: Job) {
    const temporary = `${this.file(job.id)}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(job));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, this.file(job.id));
    const dir = openSync(this.directory, "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }
  jobs(): Job[] {
    return readdirSync(this.directory)
      .filter((n) => /^\d+\.json$/.test(n))
      .map(
        (n) => JSON.parse(readFileSync(join(this.directory, n), "utf8")) as Job,
      )
      .sort((a, b) => a.id - b.id);
  }
  enqueue(job: Job): "accepted" | "duplicate" | "full" {
    const jobs = this.jobs();
    if (jobs.some((j) => j.id === job.id)) return "duplicate";
    if (jobs.filter((j) => !j.done).length >= 32) return "full";
    this.save(job);
    return "accepted";
  }
}
