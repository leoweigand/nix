import { decodeJwt } from "jose";

export const toolRegistry = {
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
}
export const maxToolCalls = 12;
// The host verifies this token cryptographically before passing it to Pi.
// This decoding only controls presentation; MCP independently enforces scopes.
export function availableTools(token?: string): string[] {
  if (!token) return [];
  const scope = decodeJwt(token).scope;
  const scopes = typeof scope === "string" ? scope.split(" ") : [];
  return Object.entries(toolRegistry)
    .filter(([, rule]) => rule.scope === null || scopes.includes(rule.scope))
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
