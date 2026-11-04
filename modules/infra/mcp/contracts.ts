import { z } from "zod";

export const mediaIdSchema = z
  .string()
  .regex(/^(movie:tmdb|tv:tvdb):[1-9]\d{0,9}$/)
  .describe("Stable identifier returned by media search and details.");
export const searchSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Movie or TV show title to find."),
    type: z.enum(["movie", "tv"]).optional(),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();
export const detailsSchema = z.object({ mediaId: mediaIdSchema }).strict();
export const requestSchema = z
  .object({
    mediaId: mediaIdSchema,
    qualityProfile: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .default("HD")
      .describe("Exact quality profile name returned by details."),
    seasons: z
      .array(z.number().int().min(0).max(9999))
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Explicit TV seasons; required for TV, omitted for movies. Specials are season 0.",
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mediaId.startsWith("tv:") !== (value.seasons !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["seasons"],
        message: "TV requires explicit seasons; movies must omit seasons",
      });
    }
    if (value.seasons && new Set(value.seasons).size !== value.seasons.length) {
      ctx.addIssue({
        code: "custom",
        path: ["seasons"],
        message: "Season numbers must be unique",
      });
    }
  });

export const actionSchema = z
  .discriminatedUnion("tool", [
    z
      .object({
        id: z.string(),
        tool: z.literal("get_media_details"),
        arguments: detailsSchema,
        requiredScope: z.literal("media:read"),
      })
      .strict(),
    z
      .object({
        id: z.string(),
        tool: z.literal("request_media"),
        arguments: requestSchema,
        requiredScope: z.literal("media:request"),
      })
      .strict(),
  ])
  .describe(
    "LeoLab convention for a ready-to-call next operation. Data only: the client chooses presentation and must not execute it without matching user intent. Arguments satisfy the referenced tool input schema.",
  );
export type MediaAction = z.infer<typeof actionSchema>;

const imageSchema = z
  .object({
    url: z
      .url()
      .startsWith("https://")
      .describe("Public artwork URL, not a private Arr image path."),
    alt: z.string(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    mimeType: z
      .enum([
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/avif",
      ])
      .optional(),
  })
  .strict();
export const summaryOutputSchema = z
  .object({
    mediaId: mediaIdSchema,
    type: z.enum(["movie", "tv"]),
    title: z.string(),
    year: z.number(),
    synopsis: z.string(),
    libraryStatus: z.enum([
      "not_requested",
      "available",
      "partially_available",
      "requested",
      "in_library",
    ]),
    inLibrary: z.boolean(),
    monitored: z.boolean(),
    alreadyAvailable: z
      .boolean()
      .nullable()
      .describe(
        "Whether the relevant media is present. Null means search cannot establish this; inspect details and TV seasons.",
      ),
    alreadyRequested: z
      .boolean()
      .nullable()
      .describe(
        "Whether missing media is already effectively monitored. Null means TV episode details are needed.",
      ),
    canRequest: z
      .boolean()
      .nullable()
      .describe(
        "Content eligibility, not authorization. Null means details are needed. Use availableActions for operations permitted to this caller.",
      ),
    images: z
      .object({
        poster: imageSchema.nullable(),
        backdrop: imageSchema.nullable(),
      })
      .strict(),
    runtimeMinutes: z.number().positive().nullable(),
    genres: z.array(z.string()),
    certification: z.string().nullable(),
    status: z
      .string()
      .nullable()
      .describe(
        "Catalog release/series status from Arr, not download progress.",
      ),
    releaseDate: z.iso.datetime().nullable(),
    releaseDates: z.array(
      z
        .object({
          type: z.enum([
            "cinema",
            "digital",
            "physical",
            "first_aired",
            "last_aired",
          ]),
          date: z.iso.datetime(),
        })
        .strict(),
    ),
    links: z.array(
      z
        .object({
          provider: z.enum(["tmdb", "tvdb", "imdb"]),
          url: z.url().startsWith("https://"),
        })
        .strict(),
    ),
    availableActions: z.array(actionSchema),
  })
  .strict();
export type MediaSummary = z.infer<typeof summaryOutputSchema>;

export const searchOutputSchema = z
  .object({
    results: z.array(summaryOutputSchema),
    errors: z.array(
      z
        .object({
          type: z.enum(["movie", "tv"]),
          error: z.literal("catalog_unavailable"),
        })
        .strict(),
    ),
  })
  .strict();
export const detailsOutputSchema = summaryOutputSchema
  .extend({
    qualityProfile: z.string().nullable(),
    qualityProfiles: z.array(z.string()),
    nextEpisode: z
      .object({
        seasonNumber: z.number().int(),
        episodeNumber: z.number().int(),
        title: z.string().nullable(),
        airDateUtc: z.iso.datetime(),
      })
      .strict()
      .nullable()
      .describe(
        "Earliest known future TV episode, including specials, regardless of monitoring or library state. Null for movies or when no future air time is known; this does not prove the series has ended. Air time is scheduled metadata, not a download or availability promise.",
      ),
    monitorNewSeasons: z.string().optional(),
    seasons: z
      .array(
        z
          .object({
            seasonNumber: z.number().int(),
            monitored: z.boolean(),
            totalEpisodes: z.number().int().nonnegative(),
            airedEpisodes: z.number().int().nonnegative(),
            availableEpisodes: z.number().int().nonnegative(),
            missingEpisodes: z.number().int().nonnegative(),
            monitoredEpisodes: z.number().int().nonnegative(),
            alreadyAvailable: z.boolean(),
            alreadyRequested: z.boolean(),
            canRequest: z.boolean(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type MediaDetails = z.infer<typeof detailsOutputSchema>;
export const requestOutputSchema = z
  .object({
    outcome: z.enum([
      "accepted",
      "already_available",
      "already_requested",
      "needs_input",
      "failed",
      "partial_failure",
    ]),
    mediaId: mediaIdSchema,
    qualityProfile: z.string(),
    seasons: z.array(z.number().int()).optional(),
    libraryChanged: z.boolean().nullable(),
    searchStarted: z.boolean(),
    searchStatus: z.enum(["not_started", "queued", "unknown"]),
    message: z.string(),
    commandId: z.number().nullable(),
    error: z.string().optional(),
    existingQualityProfile: z.string().nullable().optional(),
    qualityProfiles: z.array(z.string()).optional(),
    availableActions: z.array(actionSchema),
  })
  .strict();
export const identityOutputSchema = z
  .object({
    subject: z.string(),
    issuer: z.string(),
    clientId: z.string(),
    scopes: z.array(z.string()),
  })
  .strict();

export function detailsAction(mediaId: string): MediaAction {
  return {
    id: "details",
    tool: "get_media_details",
    arguments: { mediaId },
    requiredScope: "media:read",
  };
}
export function requestAction(
  mediaId: string,
  qualityProfile: string,
  seasons?: number[],
): MediaAction {
  return {
    id: seasons ? `request_season_${seasons.join("_")}` : "request_movie",
    tool: "request_media",
    arguments: { mediaId, qualityProfile, ...(seasons ? { seasons } : {}) },
    requiredScope: "media:request",
  };
}

export function permittedActions(
  output: Record<string, unknown>,
  scopes: readonly string[],
): Record<string, unknown> {
  const filter = (entry: Record<string, unknown>) => ({
    ...entry,
    ...(Array.isArray(entry.availableActions)
      ? {
          availableActions: (entry.availableActions as MediaAction[]).filter(
            (action) => scopes.includes(action.requiredScope),
          ),
        }
      : {}),
  });
  return {
    ...filter(output),
    ...(Array.isArray(output.results)
      ? { results: output.results.map((item) => filter(item)) }
      : {}),
  };
}
