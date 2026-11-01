import { z } from "zod";

const bookmarkId = z.number().int().positive();
const webUrl = z
  .string()
  .max(4096)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Expected an HTTP(S) URL without credentials");
export const bookmarkSearchSchema = z
  .object({
    query: z.string().max(500).default(""),
    archived: z.boolean().default(false),
    limit: z.number().int().min(1).max(20).default(5),
    offset: z.number().int().min(0).max(100000).default(0),
  })
  .strict();
export const bookmarkDetailsSchema = z.object({ bookmarkId }).strict();
export const bookmarkSaveSchema = z
  .object({
    url: webUrl,
    tags: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
    description: z.string().max(4000).optional(),
    note: z.string().max(10000).optional(),
  })
  .strict();
const backendBookmark = z.object({
  id: bookmarkId,
  url: webUrl,
  title: z.string().max(20000),
  description: z.string().max(100000),
  notes: z.string().max(200000),
  tag_names: z.array(z.string()).max(1000),
  is_archived: z.boolean(),
  unread: z.boolean(),
  shared: z.boolean(),
  date_added: z.string(),
  date_modified: z.string(),
});
const bookmarkOutput = z
  .object({
    bookmarkId,
    url: webUrl,
    title: z.string(),
    description: z.string(),
    note: z.string(),
    tags: z.array(z.string()),
    archived: z.boolean(),
    unread: z.boolean(),
    shared: z.boolean(),
    addedAt: z.string(),
    modifiedAt: z.string(),
    content: z.literal("bookmark_metadata_only"),
  })
  .strict();
export const bookmarkSearchOutput = z
  .object({
    bookmarks: z.array(bookmarkOutput),
    total: z.number().int().min(0),
    nextOffset: z.number().int().nullable(),
  })
  .strict();
export const bookmarkDetailsOutput = z
  .object({ bookmark: bookmarkOutput })
  .strict();
export const bookmarkSaveOutput = z
  .object({
    outcome: z.enum(["saved", "updated", "already_saved"]),
    bookmark: bookmarkOutput,
  })
  .strict();
export interface BookmarkConfig {
  url: string;
  ownerSubject: string;
  token: string;
}
export class BookmarkError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
export class BookmarkService {
  private origin: string;
  private ownerSubject: string;
  private apiToken: string;
  private locks = new Map<string, Promise<unknown>>();
  private request: typeof fetch;
  constructor(config: BookmarkConfig, request = fetch) {
    const url = new URL(config.url);
    if (
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw new BookmarkError("invalid_bookmark_origin");
    this.origin = url.origin;
    this.request = request;
    if (!config.ownerSubject || !/^[a-f0-9]{40}$/i.test(config.token))
      throw new BookmarkError("invalid_bookmark_configuration");
    this.ownerSubject = config.ownerSubject;
    this.apiToken = config.token;
  }
  private token(subject: unknown) {
    if (subject !== this.ownerSubject)
      throw new BookmarkError("bookmarks_forbidden");
    return this.apiToken;
  }
  private async api(
    subject: unknown,
    path: string,
    signal: AbortSignal,
    body?: unknown,
    method = "POST",
  ) {
    const token = this.token(subject);
    let response: Response;
    try {
      response = await this.request(new URL(path, this.origin), {
        method: body === undefined ? "GET" : method,
        redirect: "error",
        headers: {
          Authorization: `Token ${token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
      });
    } catch {
      throw new BookmarkError(
        body === undefined
          ? "bookmarks_unavailable"
          : "bookmark_write_unconfirmed",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new BookmarkError(
        response.status === 404
          ? "bookmark_not_found"
          : response.status === 401 || response.status === 403
            ? "bookmark_credentials_rejected"
            : body !== undefined && response.status >= 500
              ? "bookmark_write_unconfirmed"
              : "bookmark_backend_error",
      );
    }
    const reader = response.body?.getReader();
    if (!reader)
      throw new BookmarkError(
        body === undefined
          ? "invalid_bookmark_response"
          : "bookmark_write_unconfirmed",
      );
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("too large");
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new BookmarkError(
        body === undefined
          ? "invalid_bookmark_response"
          : "bookmark_write_unconfirmed",
      );
    }
  }
  private output(value: unknown) {
    const b = backendBookmark.parse(value);
    return bookmarkOutput.parse({
      bookmarkId: b.id,
      url: b.url,
      title: b.title,
      description: b.description.slice(0, 4000),
      note: b.notes.slice(0, 10000),
      tags: b.tag_names,
      archived: b.is_archived,
      unread: b.unread,
      shared: b.shared,
      addedAt: b.date_added,
      modifiedAt: b.date_modified,
      content: "bookmark_metadata_only",
    });
  }
  async search(
    subject: unknown,
    input: z.infer<typeof bookmarkSearchSchema>,
    signal: AbortSignal,
  ) {
    const args = bookmarkSearchSchema.parse(input);
    const query = new URLSearchParams({
      q: args.query,
      limit: String(args.limit),
      offset: String(args.offset),
    });
    const data = z
      .object({
        count: z.number().int().min(0),
        results: z.array(backendBookmark).max(args.limit),
      })
      .parse(
        await this.api(
          subject,
          `/api/bookmarks/${args.archived ? "archived/" : ""}?${query}`,
          signal,
        ),
      );
    return {
      bookmarks: data.results.map((b) => this.output(b)),
      total: data.count,
      nextOffset:
        args.offset + data.results.length < data.count && data.results.length
          ? args.offset + data.results.length
          : null,
    };
  }
  async details(subject: unknown, id: number, signal: AbortSignal) {
    bookmarkId.parse(id);
    return {
      bookmark: this.output(
        await this.api(subject, `/api/bookmarks/${id}/`, signal),
      ),
    };
  }
  async save(
    subject: unknown,
    input: z.infer<typeof bookmarkSaveSchema>,
    signal: AbortSignal,
  ) {
    this.token(subject);
    const args = bookmarkSaveSchema.parse(input);
    const key = subject as string;
    const previous = this.locks.get(key) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        signal.throwIfAborted();
        const checked = z
          .object({ bookmark: backendBookmark.nullable() })
          .parse(
            await this.api(
              subject,
              `/api/bookmarks/check/?${new URLSearchParams({ url: args.url })}`,
              signal,
            ),
          );
        const old = checked.bookmark;
        if (old) {
          const tags = [...new Set([...old.tag_names, ...args.tags])];
          const notes =
            args.note && !old.notes.split("\n\n").includes(args.note)
              ? [old.notes, args.note].filter(Boolean).join("\n\n")
              : old.notes;
          const body = {
            tag_names: tags,
            notes,
            ...(args.description !== undefined
              ? { description: args.description }
              : {}),
          };
          if (
            tags.length === old.tag_names.length &&
            notes === old.notes &&
            (args.description === undefined ||
              args.description === old.description)
          )
            return {
              outcome: "already_saved" as const,
              bookmark: this.output(old),
            };
          const updated = await this.api(
            subject,
            `/api/bookmarks/${old.id}/`,
            signal,
            body,
            "PATCH",
          );
          try {
            return {
              outcome: "updated" as const,
              bookmark: this.output(updated),
            };
          } catch {
            throw new BookmarkError("bookmark_write_unconfirmed");
          }
        }
        const created = await this.api(subject, "/api/bookmarks/", signal, {
          url: args.url,
          tag_names: [...new Set(args.tags)],
          shared: false,
          ...(args.description !== undefined
            ? { description: args.description }
            : {}),
          ...(args.note !== undefined ? { notes: args.note } : {}),
        });
        try {
          return { outcome: "saved" as const, bookmark: this.output(created) };
        } catch {
          throw new BookmarkError("bookmark_write_unconfirmed");
        }
      });
    this.locks.set(key, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(key) === task) this.locks.delete(key);
    }
  }
}
