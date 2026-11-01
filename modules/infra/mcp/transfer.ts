import { z } from "zod";
import { jsonFetch } from "./media.ts";
import type { transferStateSchema } from "./progress.ts";

type TransferState = z.infer<typeof transferStateSchema>;
const fileSchema = z.object({ name: z.string() });
const needSchema = z.object({
  progress: z.array(fileSchema),
  queued: z.array(fileSchema),
  rest: z.array(fileSchema),
});
export interface TransferConfig {
  url: string;
  apiKey: string;
  folder: string;
}

// Only these configured media inboxes can be correlated; no filesystem reads or caller paths.
export function syncPath(path: string): string | undefined {
  const roots = [
    "/home3/cosmicwhirl/downloads/complete/",
    "/media/sources/seedbox/",
  ];
  const root = roots.find((root) => path.startsWith(root));
  if (!root) return undefined;
  const relative = path.slice(root.length).replace(/\/$/, "");
  const parts = relative.split("/");
  if (
    parts.length < 3 ||
    parts[0] !== "deluge" ||
    !["sonarr", "radarr"].includes(parts[1]) ||
    parts.some((p) => !p || p === "." || p === ".." || p.includes("\\"))
  )
    return undefined;
  return relative;
}
export class TransferService {
  readonly config: TransferConfig;
  constructor(config: TransferConfig) {
    this.config = config;
  }
  async states(
    paths: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<Map<string, TransferState>> {
    const matched = [...paths].flatMap(([key, path]) => {
      const relative = syncPath(path);
      return relative ? [[key, relative] as const] : [];
    });
    if (!matched.length) return new Map();
    try {
      const params = new URLSearchParams({
        folder: this.config.folder,
        page: "1",
        perpage: "1000",
      });
      const need = needSchema.parse(
        await jsonFetch(
          `${this.config.url}/rest/db/need?${params}`,
          {
            headers: {
              "X-API-Key": this.config.apiKey,
              Accept: "application/json",
            },
          },
          signal,
        ),
      );
      const includes = (files: z.infer<typeof fileSchema>[], prefix: string) =>
        files.some(
          (file) => file.name === prefix || file.name.startsWith(`${prefix}/`),
        );
      return new Map(
        matched.map(([key, prefix]) => [
          key,
          includes(need.progress, prefix)
            ? "transferring_to_server"
            : includes([...need.queued, ...need.rest], prefix)
              ? "queued_for_transfer"
              : "unknown",
        ]),
      );
    } catch {
      // Never substitute an empty transfer queue for an unavailable or malformed response.
      return new Map();
    }
  }
}
