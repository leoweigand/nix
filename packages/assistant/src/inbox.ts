import type { WriteAttempt } from "./tools.ts";
import type { ReplyButton } from "./replies.ts";
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
import type { ConversationMessage } from "./conversation.ts";
import type { SessionRef } from "./sessions.ts";
import { join } from "node:path";

export interface Job {
  id: number | string;
  kind?: "notification";
  receivedAt?: number;
  order?: number;
  message?: ConversationMessage;
  session?: SessionRef;
  noticeSent?: boolean;
  generated?: boolean;
  control?: boolean;
  chatId: string;
  senderId: string;
  destination: string;
  text: string;
  messageId: number;
  topicId?: number;
  reply?: string;
  buttons?: ReplyButton[];
  replyParts?: Array<{ text: string; buttons?: ReplyButton[] }>;
  deliveredParts?: number;
  replyPrepared?: boolean;
  reactionSent?: boolean;
  reactionEmoji?: string;
  buttonsExpireAt?: number;
  done?: boolean;
  waitingForAuth?: boolean;
  authNoticeSent?: boolean;
  attachment?: { fileId: string; filename: string; size: number };
  attachmentId?: string;
  writeAttempted?: boolean;
  writeOperation?: WriteAttempt;
}
export interface Policy {
  ownerId: string;
  destinations: Map<string, string>;
  botUsername?: string;
}
export { eligibleJob, notificationJob } from "./telegram.ts";
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
  file(id: number | string) {
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
      .filter((n) => /^[a-zA-Z0-9_-]+\.json$/.test(n))
      .map(
        (n) => JSON.parse(readFileSync(join(this.directory, n), "utf8")) as Job,
      )
      .sort(
        (a, b) =>
          (a.order ?? a.receivedAt ?? Number(a.id)) -
          (b.order ?? b.receivedAt ?? Number(b.id)),
      );
  }
  enqueue(job: Job): "accepted" | "duplicate" | "full" {
    const jobs = this.jobs();
    if (jobs.some((j) => j.id === job.id)) return "duplicate";
    if (jobs.filter((j) => !j.done).length >= 32) return "full";
    job.order = Math.max(Date.now(), ...jobs.map((j) => j.order ?? 0)) + 1;
    this.save(job);
    return "accepted";
  }
}
