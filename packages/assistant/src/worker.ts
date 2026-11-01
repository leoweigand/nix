import type { Connections } from "./connections.ts";
import { callbackPath, ConnectionRequired } from "./connections.ts";
import {
  authorized,
  eligibleJob,
  type Inbox,
  type Job,
  type Policy,
} from "./inbox.ts";
import type { PiAssistant } from "./pi.ts";

type Gateway = (endpoint: string, body: unknown) => Promise<void>;
interface Options {
  secret: string;
  policy: Policy;
  inbox: Inbox;
  connections: Pick<Connections, "begin" | "complete" | "token">;
  assistant: Pick<PiAssistant, "answer">;
  gateway: Gateway;
  log?: Pick<Console, "info" | "error">;
}
export class Worker {
  options: Options;
  working = false;
  stopping = false;
  log: Pick<Console, "info" | "error">;
  constructor(options: Options) {
    this.options = options;
    this.log = options.log ?? console;
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET")
      return new Response(null, { status: 204 });
    if (url.pathname === callbackPath && request.method === "GET") {
      const headers = {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      };
      try {
        await this.options.connections.complete(url);
        // Waiting jobs themselves are the durable resumption signal, including after a crash here.
        void this.drain();
        return new Response(
          "Connected to LeoLab. You can close this page and return to Telegram; your pending request will continue automatically.",
          { headers },
        );
      } catch (error) {
        this.log.error(JSON.stringify({ event: "assistant_oauth_failed" }));
        return new Response(
          error instanceof ConnectionRequired
            ? error.message
            : "Sign-in could not be completed. Send /connect to the bot to try again.",
          { status: 400, headers },
        );
      }
    }
    if (url.pathname !== "/inbox" || request.method !== "POST")
      return new Response(null, { status: 404 });
    if (
      !authorized(
        request.headers.get("x-assistant-secret"),
        this.options.secret,
      )
    )
      return new Response(null, { status: 401 });
    try {
      if (Number(request.headers.get("content-length")) > 1024 * 1024)
        return new Response(null, { status: 413 });
      const reader = request.body?.getReader();
      let body = "";
      const decoder = new TextDecoder();
      let bytes = 0;
      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 1024 * 1024) {
              await reader.cancel();
              return new Response(null, { status: 413 });
            }
            body += decoder.decode(value, { stream: true });
          }
          body += decoder.decode();
        } finally {
          reader.releaseLock();
        }
      }
      const job = eligibleJob(JSON.parse(body), this.options.policy);
      if (!job) return new Response(null, { status: 204 });
      const result = this.options.inbox.enqueue(job);
      setImmediate(() => void this.drain());
      return new Response(null, { status: result === "full" ? 503 : 204 });
    } catch {
      return new Response(null, { status: 400 });
    }
  }
  private command(job: Job): string | undefined {
    const first =
      job.text
        .trim()
        .split(/\s+/)
        .filter(
          (part) =>
            part.toLowerCase() !==
            `@${this.options.policy.botUsername?.toLowerCase()}`,
        )[0] ?? "";
    if (first.startsWith("/")) return first.split("@")[0].toLowerCase();
    return undefined;
  }
  private async connect(job: Job): Promise<void> {
    job.waitingForAuth = true;
    this.options.inbox.save(job);
    if (job.authNoticeSent) return;
    const url = await this.options.connections.begin(job.senderId);
    // The allowlisted owner's private destination is never selected from model output.
    await this.options.gateway("/v1/notifications", {
      to: "leo",
      message: `Connect your Pocket ID account so I can search and request media for you:\n${url}\n\nThis link expires in 10 minutes. After you approve, I'll continue your pending request. Send /connect for a new link if it expires.`,
    });
    if (job.chatId !== job.senderId)
      await this.reply(
        job,
        "I've sent you a private sign-in link. I'll continue this request here after you connect.",
      );
    job.authNoticeSent = true;
    this.options.inbox.save(job);
  }
  private async reply(job: Job, message: string): Promise<void> {
    await this.options.gateway("/v1/assistant-replies", {
      to: job.destination,
      message,
      message_id: job.messageId,
      ...(job.topicId === undefined ? {} : { message_thread_id: job.topicId }),
      secret: this.options.secret,
    });
  }
  private finish(job: Job): void {
    job.done = true;
    job.text = "";
    delete job.reply;
    delete job.waitingForAuth;
    delete job.authNoticeSent;
    delete job.writeAttempted;
    this.options.inbox.save(job);
    this.log.info(
      JSON.stringify({ event: "assistant_delivered", updateId: job.id }),
    );
  }
  private async process(job: Job): Promise<void> {
    if (job.reply) {
      await this.reply(job, job.reply);
      this.finish(job);
      return;
    }
    const command = this.command(job);
    if (command === "/connect") {
      // Explicit /connect also resends a still-valid link to recover a missed DM.
      job.authNoticeSent = false;
      await this.connect(job);
      this.finish(job);
      return;
    }
    if (command === "/start" || command === "/help") {
      job.reply =
        "Hi! Ask me to look up a film or request a movie or TV season. I'll send you a private Pocket ID link when I need MCP access. /connect connects or renews your account; /reset starts a new conversation.";
    } else if (job.writeAttempted) {
      // A restart after a write cannot prove its result. Never replay acquisition automatically.
      job.reply =
        "I was interrupted after starting a media request, so I won't repeat it automatically. Ask me to check the title's current library status before trying again.";
    } else {
      const token = await this.options.connections.token(job.senderId);
      if (job.waitingForAuth && !token) {
        await this.connect(job);
        return;
      }
      if (job.waitingForAuth) {
        delete job.waitingForAuth;
        this.options.inbox.save(job);
      }
      const typing = () =>
        this.options
          .gateway("/v1/typing", { to: job.destination })
          .catch(() => {});
      await typing();
      const timer = setInterval(() => void typing(), 4500);
      let needsConnection = false;
      try {
        const input = command === "/reset" ? { ...job, text: "/reset" } : job;
        const result = await this.options.assistant.answer(input, token, () => {
          job.writeAttempted = true;
          this.options.inbox.save(job);
        });
        needsConnection = result.needsConnection;
        if (!needsConnection) job.reply = result.text;
      } catch {
        this.log.error(
          JSON.stringify({ event: "assistant_failed", updateId: job.id }),
        );
        job.reply = job.writeAttempted
          ? "The media request's result is uncertain. I won't retry it automatically; ask me to check the title's status first."
          : "I couldn't complete that request. Please try again shortly, or send /connect if my MCP connection needs renewing.";
      } finally {
        clearInterval(timer);
      }
      if (needsConnection) {
        await this.connect(job);
        return;
      }
    }
    this.options.inbox.save(job);
    await this.reply(job, job.reply!);
    this.finish(job);
  }
  async drain(): Promise<void> {
    if (this.working || this.stopping) return;
    this.working = true;
    try {
      const blockedChats = new Set<string>();
      for (const job of this.options.inbox.jobs().filter((j) => !j.done)) {
        if (this.stopping) break;
        const chat = `${job.chatId}:${job.senderId}:${job.topicId ?? 0}`;
        if (
          blockedChats.has(chat) &&
          !["/connect", "/help", "/start"].includes(this.command(job) ?? "")
        )
          continue;
        try {
          await this.process(job);
          if (job.waitingForAuth) blockedChats.add(chat);
        } catch {
          this.log.error(
            JSON.stringify({
              event: "assistant_delivery_failed",
              updateId: job.id,
            }),
          );
          break;
        }
      }
    } finally {
      this.working = false;
    }
  }
}
