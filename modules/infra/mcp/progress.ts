import { z } from "zod";
import { mediaIdSchema } from "./contracts.ts";

export const progressSchema = z
  .object({
    mediaId: mediaIdSchema
      .optional()
      .describe(
        "Omit for the current movie and TV queues; use a search result ID for one title.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("Maximum queue entries per source, not unique downloads."),
  })
  .strict();
const numberOrNull = z.number().finite().nonnegative().nullish();
const queueItemSchema = z.object({
  id: z.number().int(),
  movieId: z.number().int().nullish(),
  seriesId: z.number().int().nullish(),
  movie: z
    .object({ tmdbId: z.number().int().positive(), title: z.string() })
    .nullish(),
  series: z
    .object({ tvdbId: z.number().int().positive(), title: z.string() })
    .nullish(),
  episode: z
    .object({ seasonNumber: z.number().int(), episodeNumber: z.number().int() })
    .nullish(),
  seasonNumber: z.number().int().nullish(),
  size: numberOrNull,
  sizeleft: numberOrNull,
  estimatedCompletionTime: z.string().nullish(),
  protocol: z.enum(["torrent", "usenet"]).nullish(),
  status: z.string().nullish(),
  trackedDownloadStatus: z.string().nullish(),
  trackedDownloadState: z.string().nullish(),
  errorMessage: z.string().nullish(),
  outputPath: z.string().nullish(),
});
export const queuePageSchema = z.object({
  totalRecords: z.number().int().nonnegative(),
  records: z.array(queueItemSchema),
});
export const transferStateSchema = z.enum([
  "transferring_to_server",
  "queued_for_transfer",
  "unknown",
]);
const entrySchema = z
  .object({
    queueId: z.number().int(),
    transferState: transferStateSchema,
    mediaId: mediaIdSchema.nullable(),
    title: z.string().nullable(),
    seasonNumber: z.number().int().nullable(),
    episodeNumber: z.number().int().nullable(),
    protocol: z.enum(["torrent", "usenet"]).nullable(),
    progressSummary: z.string(),
    status: z.string().nullable(),
    trackedDownloadStatus: z.string().nullable(),
    trackedDownloadState: z.string().nullable(),
    hasIssue: z.boolean(),
    sizeBytes: z.number().finite().nonnegative().nullable(),
    remainingBytes: z.number().finite().nonnegative().nullable(),
    downloadPercent: z.number().min(0).max(100).nullable(),
    estimatedCompletionTime: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export const progressOutputSchema = z
  .object({
    observedAt: z.iso.datetime(),
    mediaId: mediaIdSchema.nullable(),
    sources: z.array(
      z
        .object({
          type: z.enum(["movie", "tv"]),
          total: z.number().int().nonnegative(),
          truncated: z.boolean(),
          entries: z.array(entrySchema),
        })
        .strict(),
    ),
    errors: z.array(
      z
        .object({
          type: z.enum(["movie", "tv"]),
          error: z.literal("queue_unavailable"),
        })
        .strict(),
    ),
    note: z.string(),
  })
  .strict();

export function queueEntry(
  item: z.infer<typeof queueItemSchema>,
  kind: "movie" | "tv",
): z.infer<typeof entrySchema> {
  const size = item.size ?? null;
  const remaining = item.sizeleft ?? null;
  const validBytes =
    size !== null && remaining !== null && size > 0 && remaining <= size;
  const media = kind === "movie" ? item.movie : item.series;
  return {
    queueId: item.id,
    transferState: "unknown",
    mediaId:
      kind === "movie" && item.movie
        ? `movie:tmdb:${item.movie.tmdbId}`
        : kind === "tv" && item.series
          ? `tv:tvdb:${item.series.tvdbId}`
          : null,
    title: media?.title ?? null,
    seasonNumber: item.episode?.seasonNumber ?? item.seasonNumber ?? null,
    episodeNumber: item.episode?.episodeNumber ?? null,
    protocol: item.protocol ?? null,
    progressSummary: "Download status unknown",
    status: item.status ?? null,
    trackedDownloadStatus: item.trackedDownloadStatus ?? null,
    trackedDownloadState: item.trackedDownloadState ?? null,
    hasIssue:
      !!item.errorMessage ||
      ["warning", "error"].includes(item.trackedDownloadStatus ?? "") ||
      item.status === "failed",
    sizeBytes: size,
    remainingBytes: remaining,
    downloadPercent: validBytes
      ? Math.min(
          remaining > 0 ? 99.9 : 100,
          Math.round((1 - remaining / size) * 1000) / 10,
        )
      : null,
    estimatedCompletionTime: z.iso
      .datetime({ offset: true })
      .safeParse(item.estimatedCompletionTime).success
      ? item.estimatedCompletionTime!
      : null,
  };
}

export function progressSummary(entry: z.infer<typeof entrySchema>): string {
  const name = entry.protocol === "torrent" ? "Torrent" : "Download";
  if (entry.transferState === "transferring_to_server")
    return `${name} is on the seedbox, currently downloading to the server`;
  if (entry.transferState === "queued_for_transfer")
    return `${name} is on the seedbox, queued for transfer to the server`;
  if (entry.status === "completed" || entry.downloadPercent === 100)
    return `${name} is downloaded on the seedbox; transfer/import status is not confirmed${entry.hasIssue ? "; Sonarr/Radarr reports a problem" : ""}`;
  if (entry.status === "downloading")
    return entry.downloadPercent === null
      ? `${name} is downloading; percentage unknown`
      : `${name} is ${entry.downloadPercent}% downloaded`;
  if (entry.status === "paused") return `${name} is paused`;
  if (entry.status === "queued") return `${name} is queued for download`;
  if (entry.status === "failed" || entry.hasIssue)
    return `${name} has a reported problem`;
  return `${name} status is unknown`;
}
