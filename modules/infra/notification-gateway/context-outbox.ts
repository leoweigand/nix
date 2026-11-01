import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
export interface NotificationContext {
  type: "notification";
  chatId: string;
  messageId: number;
  text: string;
  at: number;
}
export class ContextOutbox {
  directory: string;
  secret: string;
  transport: typeof fetch;
  draining = false;
  constructor(directory: string, secret: string, transport: typeof fetch) {
    this.directory = directory;
    this.secret = secret;
    this.transport = transport;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  enqueue(event: NotificationContext): void {
    const name = createHash("sha256")
      .update(`${event.chatId}:${event.messageId}`)
      .digest("hex");
    const temporary = join(this.directory, `${name}.tmp`),
      target = join(this.directory, `${name}.json`);
    writeFileSync(temporary, JSON.stringify(event), {
      mode: 0o600,
      flush: true,
    });
    renameSync(temporary, target);
    const fd = openSync(this.directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  async flush(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const pending = readdirSync(this.directory)
        .filter((name) => name.endsWith(".json"))
        .map((name) => ({
          name,
          event: JSON.parse(
            readFileSync(join(this.directory, name), "utf8"),
          ) as NotificationContext,
        }))
        .sort((a, b) => a.event.at - b.event.at);
      for (const { name, event } of pending) {
        try {
          const response = await this.transport("http://127.0.0.1:9090/inbox", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-assistant-secret": this.secret,
            },
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) break;
          unlinkSync(join(this.directory, name));
        } catch {
          break;
        }
      }
    } catch {
      console.error(
        "Notification context outbox could not be read; notification delivery remains available",
      );
    } finally {
      this.draining = false;
    }
  }
}
