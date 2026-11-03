import { decodeJwt } from "jose";

export const toolRegistry = {
  mcp__leolab__now_create: { scope: "now:write", write: true },
  mcp__leolab__now_list: { scope: "now:read", write: false },
  mcp__leolab__now_get: { scope: "now:read", write: false },
  mcp__leolab__now_put_source: { scope: "now:write", write: true },
  mcp__leolab__now_build: { scope: "now:write", write: true },
  mcp__leolab__now_get_build: { scope: "now:read", write: false },
  mcp__leolab__now_deploy: { scope: "now:write", write: true },
  mcp__leolab__now_rollback: { scope: "now:write", write: true },
  mcp__leolab__now_request: { scope: "now:write", write: true },
  mcp__leolab__now_logs: { scope: "now:read", write: false },
  mcp__leolab__now_destroy: { scope: "now:write", write: true },
  mcp__leolab__search_documents: { scope: "documents:read", write: false },
  mcp__leolab__get_document: { scope: "documents:read", write: false },
  mcp__leolab__ingest_document: { scope: "documents:ingest", write: true },
  mcp__leolab__get_ingestion_status: {
    scope: "documents:ingest",
    write: false,
  },
  mcp__leolab__search_bookmarks: { scope: "bookmarks:read", write: false },
  mcp__leolab__get_bookmark: { scope: "bookmarks:read", write: false },
  mcp__leolab__save_bookmark: { scope: "bookmarks:write", write: true },
  mcp__leolab__whoami: { scope: null, write: false },
  mcp__leolab__search_media: { scope: "media:read", write: false },
  mcp__leolab__get_media_details: { scope: "media:read", write: false },
  mcp__leolab__get_download_progress: { scope: "media:read", write: false },
  mcp__leolab__request_media: { scope: "media:request", write: true },
  mcp__leolab__search_home_entities: { scope: "home:read", write: false },
  mcp__leolab__get_home_entity: { scope: "home:read", write: false },
  mcp__leolab__control_home_entities: { scope: "home:control", write: true },
} as const;
export interface WriteAttempt {
  tool: string;
  entityIds?: string[];
  action?: string;
  mediaId?: string;
  url?: string;
  attachmentId?: string;
}
export const maxToolCalls = 64;
// The host verifies this token cryptographically before passing it to Pi.
// This decoding only controls presentation; MCP independently enforces scopes.
export function availableTools(
  token?: string,
  audience: "private" | "shared" = "private",
): string[] {
  if (!token) return [];
  const scope = decodeJwt(token).scope;
  const scopes = typeof scope === "string" ? scope.split(" ") : [];
  return Object.entries(toolRegistry)
    .filter(([, rule]) => rule.scope === null || scopes.includes(rule.scope))
    .filter(
      ([name]) =>
        audience === "private" ||
        (!name.startsWith("mcp__leolab__now_") &&
          ![
            "mcp__leolab__search_documents",
            "mcp__leolab__get_document",
            "mcp__leolab__ingest_document",
            "mcp__leolab__get_ingestion_status",
            "mcp__leolab__search_bookmarks",
            "mcp__leolab__get_bookmark",
            "mcp__leolab__save_bookmark",
          ].includes(name)),
    )
    .map(([name]) => name);
}
export function recordWrite(
  tool: string,
  input: Record<string, unknown>,
  save: (attempt: WriteAttempt) => void,
) {
  if (
    !(tool in toolRegistry) ||
    !toolRegistry[tool as keyof typeof toolRegistry].write
  )
    return;
  save({
    tool,
    ...(tool === "mcp__leolab__control_home_entities"
      ? {
          entityIds: Array.isArray(input.entityIds)
            ? input.entityIds.filter((v): v is string => typeof v === "string")
            : [],
          action: typeof input.action === "string" ? input.action : undefined,
        }
      : tool === "mcp__leolab__ingest_document"
        ? {
            attachmentId:
              typeof input.attachmentId === "string"
                ? input.attachmentId
                : undefined,
          }
        : tool === "mcp__leolab__save_bookmark"
          ? { url: typeof input.url === "string" ? input.url : undefined }
          : {
              mediaId:
                typeof input.mediaId === "string" ? input.mediaId : undefined,
            }),
  });
}

export class HomeWriteGuard {
  private pending = new Set<string>();
  before(tool: string, input: Record<string, unknown>) {
    if (tool !== "mcp__leolab__control_home_entities") return;
    const ids = Array.isArray(input.entityIds)
      ? input.entityIds.filter((id): id is string => typeof id === "string")
      : [];
    if (ids.some((id) => this.pending.has(id)))
      throw new Error(
        "A device command is still pending or uncertain. Read its state; do not repeat the command in this request.",
      );
    for (const id of ids) this.pending.add(id);
  }
  after(tool: string, output: unknown) {
    if (
      tool !== "mcp__leolab__control_home_entities" ||
      !output ||
      typeof output !== "object" ||
      !("results" in output) ||
      !Array.isArray(output.results)
    )
      return;
    for (const result of output.results) {
      if (
        result &&
        typeof result.entityId === "string" &&
        (["confirmed", "already_satisfied"].includes(result.outcome) ||
          (result.outcome === "failed" && result.submitted === false))
      )
        this.pending.delete(result.entityId);
    }
  }
}

export class BookmarkWriteGuard {
  private pending = new Set<string>();
  before(tool: string, input: Record<string, unknown>) {
    if (tool !== "mcp__leolab__save_bookmark" || typeof input.url !== "string")
      return;
    if (this.pending.has(input.url))
      throw new Error(
        "Bookmark save pending or uncertain; search before a new user-authorized attempt",
      );
    this.pending.add(input.url);
  }
  after(tool: string, output: unknown) {
    if (
      tool !== "mcp__leolab__save_bookmark" ||
      !output ||
      typeof output !== "object"
    )
      return;
    const result = output as { outcome?: string; bookmark?: { url?: string } };
    if (
      result.bookmark?.url &&
      ["saved", "updated", "already_saved"].includes(result.outcome ?? "")
    )
      this.pending.delete(result.bookmark.url);
  }
}

export class DocumentWriteGuard {
  private attempted = new Set<string>();
  before(tool: string, input: Record<string, unknown>) {
    if (tool !== "mcp__leolab__ingest_document") return;
    if (
      typeof input.attachmentId !== "string" ||
      this.attempted.has(input.attachmentId)
    )
      throw new Error(
        "Document ingestion already attempted; inspect its receipt instead of retrying",
      );
    this.attempted.add(input.attachmentId);
  }
}
