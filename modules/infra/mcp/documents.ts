import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";

export const maxDocumentBytes = 20 * 1024 * 1024;
const id = z.number().int().positive();
const reference = z.string().uuid();
const date = z.iso.date();
export const documentSearchSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    createdAfter: date.optional(),
    createdBefore: date.optional(),
    correspondentId: id.optional(),
    tagIds: z.array(id).max(20).optional(),
    limit: z.number().int().min(1).max(20).default(5),
    page: z.number().int().min(1).max(10000).default(1),
  })
  .strict();
export const documentDetailsSchema = z
  .object({
    documentId: id,
    offset: z.number().int().min(0).max(2000000).default(0),
    limit: z.number().int().min(1).max(20000).default(10000),
  })
  .strict();
export const documentIngestSchema = z
  .object({
    attachmentId: reference,
    title: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export const documentStatusSchema = z
  .object({ ingestionId: reference })
  .strict();
const documentOutput = z
  .object({
    documentId: id,
    title: z.string(),
    createdAt: z.string().nullable(),
    correspondentId: id.nullable(),
    tagIds: z.array(id),
    link: z.string().url(),
    excerpt: z.string(),
  })
  .strict();
export const documentSearchOutput = z
  .object({
    documents: z.array(documentOutput),
    total: z.number().int().min(0),
    nextPage: z.number().int().nullable(),
  })
  .strict();
export const documentDetailsOutput = z
  .object({
    document: documentOutput,
    text: z.string(),
    offset: z.number().int(),
    nextOffset: z.number().int().nullable(),
    totalCharacters: z.number().int(),
    content: z.literal("untrusted_document_text"),
  })
  .strict();
export const documentIngestOutput = z
  .object({
    ingestionId: reference,
    outcome: z.enum(["submitted", "unconfirmed"]),
    taskId: reference.nullable(),
  })
  .strict();
export const documentStatusOutput = z
  .object({
    ingestionId: reference,
    outcome: z.enum([
      "processing",
      "filed",
      "duplicate",
      "failed",
      "unconfirmed",
    ]),
    documentId: id.nullable(),
    link: z.string().url().nullable(),
  })
  .strict();
const backendDocument = z.object({
  id,
  title: z.string().max(20000),
  content: z.string().max(2000000).default(""),
  created: z.string().nullable().default(null),
  correspondent: id.nullable().default(null),
  tags: z.array(id).default([]),
  __search_hit__: z
    .object({ highlights: z.string().max(2000000).optional() })
    .optional(),
});

export class DocumentError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export async function boundedBytes(response: Response, limit: number) {
  const reader = response.body?.getReader();
  if (!reader) throw new DocumentError("empty_response");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new DocumentError("response_too_large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

// Resolve groups from the issuer, never from caller-supplied headers or tool inputs.
export class DocumentAccess {
  constructor(
    privateIssuer: string,
    privateGroup = "admins",
    privateRequest = fetch,
  ) {
    this.issuer = new URL(privateIssuer).origin;
    this.group = privateGroup;
    this.request = privateRequest;
  }
  private issuer: string;
  private group: string;
  private request: typeof fetch;
  async require(
    auth: AuthInfo,
    scope: string,
    signal: AbortSignal,
  ): Promise<string> {
    if (!auth.scopes.includes(scope))
      throw new DocumentError("documents_missing_scope");
    if (
      !auth.scopes.includes("openid") ||
      !auth.scopes.includes("groups") ||
      typeof auth.extra?.subject !== "string"
    )
      throw new DocumentError("documents_group_consent_required");
    try {
      const response = await this.request(`${this.issuer}/api/oidc/userinfo`, {
        headers: { Authorization: `Bearer ${auth.token}` },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error();
      }
      const info = z
        .object({ sub: z.string(), groups: z.array(z.string()).max(1000) })
        .parse(
          JSON.parse(
            (await boundedBytes(response, 64 * 1024)).toString("utf8"),
          ),
        );
      if (info.sub !== auth.extra.subject || !info.groups.includes(this.group))
        throw new DocumentError("documents_forbidden");
      return info.sub;
    } catch (error) {
      if (
        error instanceof DocumentError &&
        error.code === "documents_forbidden"
      )
        throw error;
      throw new DocumentError("documents_membership_unavailable");
    }
  }
}
interface Attachment {
  subject: string;
  filename: string;
  mime: string;
  expiresAt: number;
  checksum: string;
}
interface Receipt {
  subject: string;
  attachmentId: string;
  checksum: string;
  title?: string;
  taskId: string | null;
}
function atomicJson(path: string, value: unknown) {
  const temp = `${path}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  const dir = openSync(join(path, ".."), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}
export function documentMime(bytes: Uint8Array): string {
  const b = Buffer.from(bytes);
  if (b.subarray(0, 5).toString() === "%PDF-") return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (
    b.subarray(0, 4).toString() === "RIFF" &&
    b.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  throw new DocumentError("unsupported_document_type");
}
export class DocumentService {
  private origin: string;
  private publicOrigin: string;
  private token: string;
  private directory: string;
  private request: typeof fetch;
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    config: { url: string; publicUrl: string; token: string; stateDir: string },
    request = fetch,
  ) {
    const origin = new URL(config.url),
      publicOrigin = new URL(config.publicUrl);
    if (
      origin.pathname !== "/" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      !["http:", "https:"].includes(origin.protocol) ||
      publicOrigin.protocol !== "https:" ||
      publicOrigin.pathname !== "/" ||
      publicOrigin.username ||
      publicOrigin.password ||
      publicOrigin.search ||
      publicOrigin.hash ||
      !config.token.trim() ||
      /\s/.test(config.token)
    )
      throw new DocumentError("invalid_document_configuration");
    this.origin = origin.origin;
    this.publicOrigin = publicOrigin.origin;
    this.token = config.token;
    this.directory = config.stateDir;
    this.request = request;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private file(ref: string, suffix: string) {
    reference.parse(ref);
    return join(this.directory, `${ref}.${suffix}`);
  }
  private load<T>(ref: string, suffix: string): T {
    try {
      return JSON.parse(readFileSync(this.file(ref, suffix), "utf8")) as T;
    } catch {
      throw new DocumentError("document_reference_not_found");
    }
  }
  private link(documentId: number) {
    return `${this.publicOrigin}/documents/${documentId}/details`;
  }
  private output(raw: unknown) {
    const d = backendDocument.parse(raw);
    return {
      documentId: d.id,
      title: d.title,
      createdAt: d.created,
      correspondentId: d.correspondent,
      tagIds: d.tags,
      link: this.link(d.id),
      excerpt: (d.__search_hit__?.highlights ?? d.content)
        .replace(/<[^>]*>/g, "")
        .slice(0, 600),
    };
  }
  private async api(
    path: string,
    signal: AbortSignal,
    body?: FormData,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.request(new URL(path, this.origin), {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Token ${this.token}`,
          Accept: "application/json; version=9",
        },
        body,
        redirect: "error",
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(body ? 30000 : 10000),
        ]),
      });
    } catch {
      throw new DocumentError(
        body ? "document_write_unconfirmed" : "documents_unavailable",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DocumentError(
        response.status === 404
          ? "document_not_found"
          : [401, 403].includes(response.status)
            ? "paperless_credentials_rejected"
            : body
              ? "document_write_unconfirmed"
              : "paperless_backend_error",
      );
    }
    try {
      return JSON.parse(
        (await boundedBytes(response, 16 * 1024 * 1024)).toString("utf8"),
      );
    } catch {
      throw new DocumentError(
        body ? "document_write_unconfirmed" : "invalid_document_response",
      );
    }
  }
  async search(
    input: z.infer<typeof documentSearchSchema>,
    signal: AbortSignal,
  ) {
    const args = documentSearchSchema.parse(input);
    const q = new URLSearchParams({
      query: args.query,
      page_size: String(args.limit),
      page: String(args.page),
    });
    if (args.createdAfter) q.set("created__date__gte", args.createdAfter);
    if (args.createdBefore) q.set("created__date__lte", args.createdBefore);
    if (args.correspondentId)
      q.set("correspondent__id", String(args.correspondentId));
    if (args.tagIds?.length) q.set("tags__id__all", args.tagIds.join(","));
    const data = z
      .object({
        count: z.number().int().min(0),
        results: z.array(backendDocument).max(args.limit),
      })
      .parse(await this.api(`/api/documents/?${q}`, signal));
    return {
      documents: data.results.map((d) => this.output(d)),
      total: data.count,
      nextPage:
        args.page * args.limit < data.count && data.results.length
          ? args.page + 1
          : null,
    };
  }
  async details(
    input: z.infer<typeof documentDetailsSchema>,
    signal: AbortSignal,
  ) {
    const args = documentDetailsSchema.parse(input);
    const d = backendDocument.parse(
      await this.api(`/api/documents/${args.documentId}/`, signal),
    );
    const text = d.content.slice(args.offset, args.offset + args.limit);
    return {
      document: this.output(d),
      text,
      offset: args.offset,
      nextOffset:
        args.offset + text.length < d.content.length
          ? args.offset + text.length
          : null,
      totalCharacters: d.content.length,
      content: "untrusted_document_text" as const,
    };
  }
  prune() {
    let total = 0;
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".attachment")) continue;
      const ref = name.slice(0, -11);
      const a = this.load<Attachment>(ref, "attachment");
      if (a.expiresAt < Date.now()) {
        for (const suffix of ["attachment", "bytes"]) {
          try {
            unlinkSync(this.file(ref, suffix));
          } catch {
            /* Interrupted staging may have no bytes. */
          }
        }
      } else {
        try {
          total += statSync(this.file(ref, "bytes")).size;
        } catch {
          /* incomplete staging */
        }
      }
    }
    // A crash before metadata is committed can leave bytes without an attachment record.
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".bytes")) continue;
      const ref = name.slice(0, -6);
      if (existsSync(this.file(ref, "attachment"))) continue;
      const path = this.file(ref, "bytes"),
        stat = statSync(path);
      if (stat.mtimeMs + 24 * 60 * 60 * 1000 < Date.now()) unlinkSync(path);
      else total += stat.size;
    }
    return total;
  }
  stage(subject: string, filename: string, bytes: Buffer) {
    if (!subject || !bytes.length || bytes.length > maxDocumentBytes)
      throw new DocumentError("invalid_document_upload");
    const mime = documentMime(bytes);
    const total = this.prune();
    if (total + bytes.length > 200 * 1024 * 1024)
      throw new DocumentError("document_staging_full");
    const attachmentId = randomUUID();
    const safeName =
      filename
        .replace(/[^\p{L}\p{N} ._-]/gu, "_")
        .slice(0, 200)
        .replace(/^\.+/, "") || "document";
    const fd = openSync(this.file(attachmentId, "bytes"), "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    atomicJson(this.file(attachmentId, "attachment"), {
      subject,
      filename: safeName,
      mime,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      checksum: createHash("sha256").update(bytes).digest("hex"),
    } satisfies Attachment);
    return {
      attachmentId,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }
  async ingest(
    subject: string,
    input: z.infer<typeof documentIngestSchema>,
    signal: AbortSignal,
  ) {
    const args = documentIngestSchema.parse(input);
    const attachment = this.load<Attachment>(args.attachmentId, "attachment");
    if (attachment.subject !== subject)
      throw new DocumentError("documents_forbidden");
    const key = `${subject}:${attachment.checksum}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        for (const name of readdirSync(this.directory).filter((n) =>
          n.endsWith(".receipt"),
        )) {
          const ingestionId = name.slice(0, -8),
            receipt = this.load<Receipt>(ingestionId, "receipt");
          if (
            receipt.subject === subject &&
            receipt.checksum === attachment.checksum
          )
            return {
              ingestionId,
              outcome: receipt.taskId
                ? ("submitted" as const)
                : ("unconfirmed" as const),
              taskId: receipt.taskId,
            };
        }
        if (attachment.expiresAt < Date.now())
          throw new DocumentError("document_attachment_expired");
        const bytes = readFileSync(this.file(args.attachmentId, "bytes"));
        const form = new FormData();
        form.set(
          "document",
          new Blob([bytes], { type: attachment.mime }),
          attachment.filename,
        );
        if (args.title) form.set("title", args.title);
        const ingestionId = randomUUID();
        const receipt: Receipt = {
          subject,
          attachmentId: args.attachmentId,
          checksum: attachment.checksum,
          title: args.title,
          taskId: null,
        };
        signal.throwIfAborted();
        // Persist before the write. An interrupted or unconfirmed submission is never replayed.
        atomicJson(this.file(ingestionId, "receipt"), receipt);
        try {
          receipt.taskId = reference.parse(
            await this.api("/api/documents/post_document/", signal, form),
          );
          atomicJson(this.file(ingestionId, "receipt"), receipt);
          return {
            ingestionId,
            outcome: "submitted" as const,
            taskId: receipt.taskId,
          };
        } catch {
          return { ingestionId, outcome: "unconfirmed" as const, taskId: null };
        }
      });
    this.locks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(key) === task) this.locks.delete(key);
    }
  }
  async status(subject: string, ingestionId: string, signal: AbortSignal) {
    const receipt = this.load<Receipt>(ingestionId, "receipt");
    if (receipt.subject !== subject)
      throw new DocumentError("documents_forbidden");
    const result = (
      outcome: z.infer<typeof documentStatusOutput>["outcome"],
      documentId: number | null = null,
    ) => ({
      ingestionId,
      outcome,
      documentId,
      link: documentId ? this.link(documentId) : null,
    });
    if (!receipt.taskId) return result("unconfirmed");
    const raw = await this.api(
      `/api/tasks/?${new URLSearchParams({ task_id: receipt.taskId })}`,
      signal,
    );
    const items = z
      .array(
        z.object({
          task_id: reference,
          status: z.string(),
          related_document: z
            .union([id, z.string().regex(/^\d+$/)])
            .nullable()
            .optional(),
          result: z.string().nullable().optional(),
        }),
      )
      .max(100)
      .parse(
        Array.isArray(raw)
          ? raw
          : z.object({ results: z.array(z.unknown()) }).parse(raw).results,
      );
    const task = items.find((t) => t.task_id === receipt.taskId);
    if (!task) return result("unconfirmed");
    const documentId = task.related_document
      ? Number(task.related_document)
      : null;
    if (task.status === "SUCCESS")
      return result(documentId ? "filed" : "unconfirmed", documentId);
    if (task.status === "FAILURE")
      return result(
        /duplicate/i.test(task.result ?? "") ? "duplicate" : "failed",
      );
    return result(
      ["PENDING", "STARTED", "RETRY", "RECEIVED"].includes(task.status)
        ? "processing"
        : "unconfirmed",
    );
  }
}
