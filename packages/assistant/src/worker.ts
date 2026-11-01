import type { Connections } from "./connections.ts";
import { callbackPath, ConnectionRequired } from "./connections.ts";
import {
  authorized,
  eligibleJob,
  notificationJob,
  type Inbox,
  type Job,
  type Policy,
} from "./inbox.ts";
import { messageForJob } from "./telegram.ts";
import { Sessions } from "./sessions.ts";
import type { PiAssistant } from "./pi.ts";
import { randomBytes } from "node:crypto";

type Gateway = (endpoint: string, body: unknown) => Promise<void>;
interface Options {
  secret: string;
  sessions: Sessions;
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
      const payload = JSON.parse(body);
      if (payload && typeof payload === "object" && payload.callback_query) {
        const callback = payload.callback_query;
        if (
          typeof callback !== "object" ||
          !callback ||
          typeof callback.data !== "string" ||
          !callback.from ||
          String(callback.from.id) !== this.options.policy.ownerId ||
          !callback.message?.chat ||
          !Number.isSafeInteger(callback.message.message_id)
        )
          return new Response(null, { status: 204 });
        const chatId = String(callback.message.chat.id);
        const original = this.options.inbox
          .jobs()
          .find(
            (candidate) =>
              candidate.chatId === chatId &&
              candidate.senderId === this.options.policy.ownerId &&
              (candidate.buttonsExpireAt ?? 0) > Date.now() &&
              candidate.buttons?.some(
                (button) => button.token === callback.data,
              ),
          );
        const button = original?.buttons?.find(
          (item) => item.token === callback.data,
        );
        if (!original || !button) return new Response(null, { status: 204 });
        const result = this.options.inbox.enqueue({
          id: `choice-${original.id}`,
          chatId,
          senderId: original.senderId,
          destination: original.destination,
          text: button.label,
          messageId: callback.message.message_id,
          ...(original.topicId === undefined
            ? {}
            : { topicId: original.topicId }),
          receivedAt: Date.now(),
        });
        if (result === "full") return new Response(null, { status: 503 });
        setImmediate(() => void this.drain());
        return new Response(null, { status: 204 });
      }
      const job =
        notificationJob(payload, this.options.policy) ??
        eligibleJob(payload, this.options.policy);
      if (!job) return new Response(null, { status: 204 });
      const result = this.options.inbox.enqueue(job);
      setImmediate(() => void this.drain());
      return new Response(null, { status: result === "full" ? 503 : 204 });
    } catch {
      return new Response(null, { status: 400 });
    }
  }
  private prepare(job: Job, reset = false): void {
    if (!job.session) {
      const message = messageForJob(job);
      job.session = this.options.sessions.select(
        message.conversationId,
        message.at,
        reset,
      );
      this.options.inbox.save(job);
    }
  }
  private async notice(job: Job): Promise<void> {
    if (job.session?.notice && !job.noticeSent) {
      await this.reply(job, job.session.notice);
      job.noticeSent = true;
      this.options.inbox.save(job);
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
    const message = `Connect your Pocket ID account so I can search and request media for you:\n${url}\n\nThis link expires in 10 minutes. After you approve, I'll continue your pending request. Send /connect for a new link if it expires.`;
    // The allowlisted owner's private destination is never selected from model output.
    if (job.chatId === job.senderId) {
      await this.options.gateway("/v1/assistant-replies", {
        secret: this.options.secret,
        to: "leo",
        message,
      });
    } else {
      try {
        await this.options.gateway("/v1/assistant-replies", {
          secret: this.options.secret,
          to: job.destination,
          message,
          ephemeral_receiver: job.senderId,
          message_id: job.messageId,
          ...(job.topicId === undefined
            ? {}
            : { message_thread_id: job.topicId }),
        });
      } catch {
        await this.options.gateway("/v1/assistant-replies", {
          secret: this.options.secret,
          to: "leo",
          message,
        });
        await this.reply(
          job,
          "I've sent you a private sign-in link in our DM. I'll continue here after you connect.",
        );
      }
    }
    job.authNoticeSent = true;
    this.options.inbox.save(job);
  }
  private async reply(job: Job, message: string, rich = false): Promise<void> {
    await this.options.gateway("/v1/assistant-replies", {
      to: job.destination,
      message,
      ...(rich ? { rich: true } : {}),
      ...(rich && job.buttons?.length ? { buttons: job.buttons } : {}),
      message_id: job.messageId,
      ...(job.topicId === undefined ? {} : { message_thread_id: job.topicId }),
      secret: this.options.secret,
    });
  }
  private async deliver(job: Job): Promise<void> {
    if (job.session) {
      const manager = this.options.sessions.open(job.session);
      const count = manager
        .getEntries()
        .filter((e) => e.type === "compaction").length;
      const previous = [...manager.getEntries()]
        .reverse()
        .find(
          (e) => e.type === "custom" && e.customType === "compaction-notice",
        );
      const noticed =
        previous?.type === "custom"
          ? Number((previous.data as { count: number }).count)
          : 0;
      if (count > noticed) {
        await this.reply(
          job,
          "Earlier conversation in this session has been summarized.",
        );
        manager.appendCustomEntry("compaction-notice", { count });
      }
    }
    await this.reply(job, job.reply!, job.generated === true);
    this.finish(job);
  }
  private finish(job: Job): void {
    if (job.session && job.kind !== "notification" && !job.control && job.reply)
      this.options.sessions.delivered(
        job.session,
        `reply-${job.id}`,
        job.reply,
        job.generated ?? false,
      );
    job.done = true;
    job.text = "";
    delete job.message;
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
      await this.deliver(job);
      return;
    }
    const command = this.command(job);
    if (job.kind === "notification") {
      this.prepare(job);
      this.options.sessions.record(job.session!, messageForJob(job));
      await this.notice(job);
      this.finish(job);
      return;
    }
    if (command === "/session") {
      job.control = true;
      job.reply = this.options.sessions.status(
        messageForJob(job).conversationId,
      );
    } else if (command === "/reset") {
      job.control = true;
      this.prepare(job, true);
      job.reply = job.session!.notice!;
      job.noticeSent = true;
    } else if (command === "/connect") {
      job.control = true;
      // Explicit /connect also resends a still-valid link to recover a missed DM.
      job.authNoticeSent = false;
      await this.connect(job);
      this.finish(job);
      return;
    }
    if (command === "/start" || command === "/help") {
      job.control = true;
      job.reply =
        "Hi! Ask me to look up a film or request a movie or TV season. I'll send you a private Pocket ID link when I need MCP access. /connect connects or renews your account; /reset starts a new conversation; /session shows the current session. Sessions restart after ten conversation messages or ten minutes of inactivity.";
    } else if (job.control) {
      // Deterministic commands do not invoke the model or consume the conversation budget.
    } else if (job.writeAttempted) {
      // A restart after a write cannot prove its result. Never replay acquisition automatically.
      job.reply =
        "I was interrupted after starting a media request, so I won't repeat it automatically. Ask me to check the title's current library status before trying again.";
    } else {
      this.prepare(job);
      this.options.sessions.record(job.session!, messageForJob(job));
      await this.notice(job);
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
        const result = await this.options.assistant.answer(
          messageForJob(job),
          job.session!,
          token,
          () => {
            job.writeAttempted = true;
            this.options.inbox.save(job);
          },
          async (emoji) =>
            this.options.gateway("/v1/reactions", {
              to: job.destination,
              message_id: job.messageId,
              emoji,
            }),
        );
        needsConnection = result.needsConnection;
        if (!needsConnection) {
          job.reply = result.text;
          job.generated = true;
          if (result.buttons?.length) {
            job.buttons = result.buttons.map((button) =>
              button.url
                ? button
                : { ...button, token: randomBytes(18).toString("base64url") },
            );
            job.buttonsExpireAt = Date.now() + 10 * 60 * 1000;
          }
        }
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
    await this.deliver(job);
  }
  async drain(): Promise<void> {
    if (this.working || this.stopping) return;
    this.working = true;
    try {
      const blockedChats = new Map<string, string>();
      for (const job of this.options.inbox.jobs().filter((j) => !j.done)) {
        if (this.stopping) break;
        const message = messageForJob(job);
        const chat = message.conversationId;
        try {
          if (
            blockedChats.has(chat) &&
            job.kind !== "notification" &&
            !["/connect", "/help", "/start", "/reset", "/session"].includes(
              this.command(job) ?? "",
            )
          ) {
            const candidate =
              job.session ?? this.options.sessions.select(chat, message.at);
            if (candidate.file === blockedChats.get(chat)) continue;
            job.session = candidate;
            this.options.inbox.save(job);
          }
          await this.process(job);
          if (job.waitingForAuth && job.session)
            blockedChats.set(chat, job.session.file);
          if (this.command(job) === "/reset") blockedChats.delete(chat);
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
