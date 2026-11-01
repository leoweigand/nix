import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import {
  mediaIdSchema,
  searchSchema,
  detailsSchema,
  requestSchema,
  detailsAction,
  requestAction,
  type MediaSummary,
  type MediaAction,
  type MediaDetails,
  requestOutputSchema,
} from "./contracts.ts";
import { mediaMetadata } from "./artwork.ts";
export { mediaIdSchema, searchSchema, detailsSchema, requestSchema };

const seasonSchema = z
  .object({
    seasonNumber: z.number().int(),
    monitored: z.boolean().default(false),
  })
  .passthrough();
const itemSchema = z
  .object({
    id: z.number().int().default(0),
    title: z.string(),
    year: z.number().default(0),
    overview: z.string().nullish(),
    tmdbId: z.number().optional(),
    tvdbId: z.number().optional(),
    monitored: z.boolean().default(false),
    hasFile: z.boolean().default(false),
    qualityProfileId: z.number().default(0),
    monitorNewItems: z.string().optional(),
    seasons: z.array(seasonSchema).default([]),
    statistics: z
      .object({
        episodeFileCount: z.number().default(0),
        totalEpisodeCount: z.number().default(0),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
type Item = z.infer<typeof itemSchema>;
const storedItemSchema = itemSchema.extend({ id: z.number().int().positive() });
const episodeSchema = z
  .object({
    id: z.number().int().optional(),
    seasonNumber: z.number().int(),
    episodeNumber: z.number().int(),
    airDateUtc: z.string().nullish(),
    hasFile: z.boolean().default(false),
    monitored: z.boolean().default(false),
  })
  .passthrough();
type Episode = z.infer<typeof episodeSchema>;
const profileSchema = z.object({ id: z.number().int(), name: z.string() });
type Kind = "movie" | "tv";
interface Endpoint {
  url: string;
  apiKey: string;
  rootFolder: string;
}
export interface MediaConfig {
  sonarr: Endpoint;
  radarr: Endpoint;
}

export class MediaError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
async function jsonFetch(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<unknown> {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([
        AbortSignal.timeout(10_000),
        ...(signal ? [signal] : []),
      ]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaError(`upstream_http_${response.status}`);
    }
    if (response.status === 204) return null;
    // Bound metadata and library responses without trusting Content-Length.
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16 * 1024 * 1024) {
        await reader.cancel();
        throw new MediaError("upstream_response_too_large");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof MediaError) throw error;
    throw new MediaError(
      signal?.aborted ? "request_cancelled" : "upstream_unavailable",
    );
  }
}

class Arr {
  readonly endpoint: Endpoint;
  readonly collection: "series" | "movie";
  constructor(endpoint: Endpoint, collection: "series" | "movie") {
    this.endpoint = endpoint;
    this.collection = collection;
  }
  async api(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ) {
    return jsonFetch(
      `${this.endpoint.url}/api/v3/${path}`,
      {
        method,
        headers: {
          "X-Api-Key": this.endpoint.apiKey,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      signal,
    );
  }
  async library(signal?: AbortSignal) {
    return z
      .array(storedItemSchema)
      .parse(await this.api(this.collection, "GET", undefined, signal));
  }
  async lookup(term: string, signal?: AbortSignal) {
    return z
      .array(itemSchema)
      .parse(
        await this.api(
          `${this.collection}/lookup?term=${encodeURIComponent(term)}`,
          "GET",
          undefined,
          signal,
        ),
      );
  }
  async profiles(signal?: AbortSignal) {
    return z
      .array(profileSchema)
      .parse(await this.api("qualityprofile", "GET", undefined, signal));
  }
  async episodes(id: number, signal?: AbortSignal) {
    return z
      .array(episodeSchema.extend({ id: z.number().int().positive() }))
      .parse(
        await this.api(`episode?seriesId=${id}`, "GET", undefined, signal),
      );
  }
}
function identify(mediaId: string) {
  mediaIdSchema.parse(mediaId);
  const [type, , externalId] = mediaId.split(":");
  return { kind: type as Kind, externalId: Number(externalId) };
}
function hasAired(episode: Episode, now: number) {
  return (
    !!episode.airDateUtc &&
    Number.isFinite(Date.parse(episode.airDateUtc)) &&
    Date.parse(episode.airDateUtc) <= now
  );
}
function summary(item: Item, kind: Kind, existing?: Item): MediaSummary {
  const available =
    kind === "movie"
      ? existing?.hasFile
      : (existing?.statistics?.episodeFileCount ?? 0) > 0;
  const complete =
    (existing?.statistics?.totalEpisodeCount ?? 0) > 0 &&
    existing!.statistics!.episodeFileCount >=
      existing!.statistics!.totalEpisodeCount;
  return {
    mediaId:
      kind === "movie" ? `movie:tmdb:${item.tmdbId}` : `tv:tvdb:${item.tvdbId}`,
    type: kind,
    title: item.title,
    year: item.year,
    synopsis: item.overview ?? "",
    libraryStatus: !existing
      ? "not_requested"
      : available
        ? kind === "movie" || complete
          ? "available"
          : "partially_available"
        : existing.monitored
          ? "requested"
          : "in_library",
    inLibrary: !!existing,
    monitored: existing?.monitored ?? false,
    ...mediaMetadata(item, kind),
    alreadyAvailable:
      kind === "movie"
        ? !!existing?.hasFile
        : !existing
          ? false
          : complete
            ? true
            : null,
    alreadyRequested:
      kind === "movie"
        ? !!existing?.monitored && !existing.hasFile
        : existing
          ? null
          : false,
    canRequest:
      kind === "movie" ? !existing?.hasFile && !existing?.monitored : null,
    availableActions: [
      detailsAction(
        kind === "movie"
          ? `movie:tmdb:${item.tmdbId}`
          : `tv:tvdb:${item.tvdbId}`,
      ),
    ],
  };
}

export class MediaService {
  readonly movie: Arr;
  readonly tv: Arr;
  readonly metadataBase: string;
  readonly now: () => number;
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(
    config: MediaConfig,
    options: { metadataBase?: string; now?: () => number } = {},
  ) {
    this.movie = new Arr(config.radarr, "movie");
    this.tv = new Arr(config.sonarr, "series");
    this.metadataBase =
      options.metadataBase ?? "https://skyhook.sonarr.tv/v1/tvdb/shows/en";
    this.now = options.now ?? Date.now;
  }
  async search(input: z.infer<typeof searchSchema>, signal?: AbortSignal) {
    const types: Kind[] = input.type ? [input.type] : ["movie", "tv"];
    const searches = await Promise.allSettled(
      types.map(async (kind) => {
        const [matches, library] = await Promise.all([
          this[kind].lookup(input.query, signal),
          this[kind].library(signal),
        ]);
        return matches
          .filter((x) => (kind === "movie" ? x.tmdbId : x.tvdbId))
          .map((item) =>
            summary(
              item,
              kind,
              library.find((entry) =>
                kind === "movie"
                  ? entry.tmdbId === item.tmdbId
                  : entry.tvdbId === item.tvdbId,
              ),
            ),
          );
      }),
    );
    // Interleave sources so a combined search includes both movies and TV.
    const lists = searches.map((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const results = [];
    for (
      let i = 0;
      results.length < input.limit &&
      i < Math.max(...lists.map((x) => x.length));
      i++
    ) {
      for (const list of lists)
        if (list[i] && results.length < input.limit) results.push(list[i]);
    }
    return {
      results,
      errors: searches.flatMap((result, i) =>
        result.status === "rejected"
          ? [{ type: types[i], error: "catalog_unavailable" }]
          : [],
      ),
    };
  }
  private async resolve(mediaId: string, signal?: AbortSignal) {
    const { kind, externalId } = identify(mediaId);
    const arr = this[kind];
    const [library, profiles] = await Promise.all([
      arr.library(signal),
      arr.profiles(signal),
    ]);
    const existing = library.find((entry) =>
      kind === "movie"
        ? entry.tmdbId === externalId
        : entry.tvdbId === externalId,
    );
    const item =
      existing ??
      (
        await arr.lookup(
          `${kind === "movie" ? "tmdb" : "tvdb"}:${externalId}`,
          signal,
        )
      ).find((entry) =>
        kind === "movie"
          ? entry.tmdbId === externalId
          : entry.tvdbId === externalId,
      );
    if (!item) throw new MediaError("media_not_found");
    return { kind, arr, item, existing, profiles, externalId };
  }
  private async catalogEpisodes(tvdbId: number, signal?: AbortSignal) {
    const data = await jsonFetch(
      `${this.metadataBase}/${tvdbId}`,
      { headers: { Accept: "application/json" } },
      signal,
    );
    return z.object({ episodes: z.array(episodeSchema) }).parse(data).episodes;
  }
  async details(mediaId: string, signal?: AbortSignal): Promise<MediaDetails> {
    const { kind, arr, item, existing, profiles, externalId } =
      await this.resolve(mediaId, signal);
    const episodes =
      kind === "tv"
        ? existing
          ? await arr.episodes(existing.id, signal)
          : await this.catalogEpisodes(externalId, signal)
        : [];
    const now = this.now();
    const result = {
      ...summary(item, kind, existing),
      qualityProfile:
        profiles.find((p) => p.id === existing?.qualityProfileId)?.name ?? null,
      qualityProfiles: profiles.map((p) => p.name),
      availableActions: [] as MediaAction[],
    };
    const profile = existing
      ? result.qualityProfile
      : profiles.find((p) => p.name === "HD")?.name;
    if (kind === "movie") {
      if (result.canRequest && profile)
        result.availableActions.push(requestAction(mediaId, profile));
      return result;
    }
    const seasons = item.seasons.map((season) => {
      const selected = episodes.filter(
        (e) => e.seasonNumber === season.seasonNumber,
      );
      const aired = selected.filter((e) => hasAired(e, now));
      const missing = aired.filter((e) => !e.hasFile);
      const alreadyAvailable = aired.length > 0 && missing.length === 0;
      const alreadyRequested =
        !!existing?.monitored &&
        missing.length > 0 &&
        missing.every((e) => e.monitored);
      return {
        seasonNumber: season.seasonNumber,
        monitored: existing ? season.monitored : false,
        totalEpisodes: selected.length,
        airedEpisodes: aired.length,
        availableEpisodes: selected.filter((e) => e.hasFile).length,
        missingEpisodes: missing.length,
        monitoredEpisodes: existing
          ? selected.filter((e) => e.monitored).length
          : 0,
        alreadyAvailable,
        alreadyRequested,
        canRequest: missing.length > 0 && !alreadyRequested,
      };
    });
    result.alreadyAvailable =
      episodes.some((e) => hasAired(e, now)) &&
      episodes.filter((e) => hasAired(e, now)).every((e) => e.hasFile);
    const missing = episodes.filter((e) => hasAired(e, now) && !e.hasFile);
    result.alreadyRequested =
      !!existing?.monitored &&
      missing.length > 0 &&
      missing.every((e) => e.monitored);
    result.canRequest = seasons.some((season) => season.canRequest);
    if (profile)
      result.availableActions = seasons
        .filter((season) => season.canRequest)
        .map((season) =>
          requestAction(mediaId, profile, [season.seasonNumber]),
        );
    return {
      ...result,
      monitorNewSeasons: existing?.monitorNewItems ?? "none",
      seasons,
    };
  }

  async request(input: z.infer<typeof requestSchema>, signal?: AbortSignal) {
    // Serialize requests for the same title; independent titles can progress concurrently.
    const prior = this.pending.get(input.mediaId) ?? Promise.resolve();
    const task = prior
      .catch(() => {})
      .then(() => this.requestLocked(input, signal));
    this.pending.set(input.mediaId, task);
    try {
      return requestOutputSchema.parse({
        ...(await task),
        availableActions: [detailsAction(input.mediaId)],
      });
    } finally {
      if (this.pending.get(input.mediaId) === task)
        this.pending.delete(input.mediaId);
    }
  }
  private async requestLocked(
    input: z.infer<typeof requestSchema>,
    signal?: AbortSignal,
  ) {
    const result = {
      outcome: "needs_input",
      mediaId: input.mediaId,
      qualityProfile: input.qualityProfile,
      ...(input.seasons ? { seasons: input.seasons } : {}),
      libraryChanged: false as boolean | null,
      searchStarted: false,
      searchStatus: "not_started",
      message: "",
      commandId: null as number | null,
    };
    let mutating = false;
    try {
      signal?.throwIfAborted();
      const resolved = await this.resolve(input.mediaId, signal);
      const { kind, arr, item, profiles } = resolved;
      let existing = resolved.existing;
      const profile = profiles.find((p) => p.name === input.qualityProfile);
      if (!profile)
        return {
          ...result,
          message: "Choose an available quality profile.",
          qualityProfiles: profiles.map((p) => p.name),
        };
      if (existing && existing.qualityProfileId !== profile.id)
        return {
          ...result,
          message:
            "The existing title uses a different quality profile. Specify that profile, or change it in Arr first.",
          existingQualityProfile:
            profiles.find((p) => p.id === existing!.qualityProfileId)?.name ??
            null,
        };
      if (kind === "movie") {
        if (existing?.hasFile)
          return {
            ...result,
            outcome: "already_available",
            message: "The movie is already in the library.",
          };
        if (existing?.monitored)
          return {
            ...result,
            outcome: "already_requested",
            message:
              "The movie is already monitored; no new search was started.",
          };
        if (!existing) {
          await this.checkRoot(arr, signal);
          mutating = true;
          result.libraryChanged = null;
          existing = storedItemSchema.parse(
            await arr.api(
              "movie",
              "POST",
              {
                ...item,
                id: undefined,
                path: undefined,
                rootFolderPath: arr.endpoint.rootFolder,
                qualityProfileId: profile.id,
                monitored: true,
                minimumAvailability: "released",
                addOptions: { searchForMovie: false },
              },
              signal,
            ),
          );
          result.libraryChanged = true;
        } else {
          mutating = true;
          result.libraryChanged = null;
          await arr.api(
            `movie/${existing.id}`,
            "PUT",
            { ...existing, monitored: true },
            signal,
          );
          result.libraryChanged = true;
        }
        const command = await arr.api(
          "command",
          "POST",
          { name: "MoviesSearch", movieIds: [existing.id] },
          signal,
        );
        result.commandId = z.object({ id: z.number() }).parse(command).id;
      } else {
        const seasons = new Set(input.seasons!);
        if (
          input.seasons!.some(
            (number) => !item.seasons.some((s) => s.seasonNumber === number),
          )
        )
          return {
            ...result,
            message:
              "One or more seasons do not exist. Inspect get_media_details.",
          };
        let episodes = existing
          ? await arr.episodes(existing.id, signal)
          : await this.catalogEpisodes(item.tvdbId!, signal);
        const now = this.now();
        const selectedAired = episodes.filter(
          (e) => seasons.has(e.seasonNumber) && hasAired(e, now),
        );
        if (!selectedAired.length)
          return {
            ...result,
            message:
              "The selected seasons have no episodes with a known past air time.",
          };
        if (selectedAired.every((e) => e.hasFile))
          return {
            ...result,
            outcome: "already_available",
            message:
              "All aired episodes in the selected seasons are already available.",
          };
        if (!existing) {
          await this.checkRoot(arr, signal);
          mutating = true;
          result.libraryChanged = null;
          existing = storedItemSchema.parse(
            await arr.api(
              "series",
              "POST",
              {
                ...item,
                id: undefined,
                path: undefined,
                rootFolderPath: arr.endpoint.rootFolder,
                qualityProfileId: profile.id,
                seasonFolder: true,
                monitored: true,
                monitorNewItems: "none",
                seasons: item.seasons.map((s) => ({ ...s, monitored: false })),
                addOptions: {
                  monitor: "none",
                  searchForMissingEpisodes: false,
                  searchForCutoffUnmetEpisodes: false,
                },
              },
              signal,
            ),
          );
          result.libraryChanged = true;
          // Sonarr populates episodes asynchronously after adding the series.
          const deadline = Date.now() + 10_000;
          do {
            episodes = await arr.episodes(existing.id, signal);
            if (
              selectedAired.every((wanted) =>
                episodes.some(
                  (e) =>
                    e.seasonNumber === wanted.seasonNumber &&
                    e.episodeNumber === wanted.episodeNumber,
                ),
              )
            )
              break;
            await delay(250, undefined, { signal });
          } while (Date.now() < deadline);
          if (
            !selectedAired.every((wanted) =>
              episodes.some(
                (e) =>
                  e.seasonNumber === wanted.seasonNumber &&
                  e.episodeNumber === wanted.episodeNumber,
              ),
            )
          )
            throw new MediaError("episode_metadata_not_ready");
        }
        // Re-read the current series before deciding how to preserve effective monitoring.
        existing = storedItemSchema.parse(
          await arr.api(`series/${existing.id}`, "GET", undefined, signal),
        );
        if (existing.qualityProfileId !== profile.id)
          return {
            ...result,
            message:
              "The quality profile changed during this request; inspect the title before retrying.",
          };
        episodes = await arr.episodes(existing.id, signal);
        const missingAired = episodes.filter(
          (e) => seasons.has(e.seasonNumber) && hasAired(e, now) && !e.hasFile,
        );
        const alreadyRequested =
          existing.monitored &&
          missingAired.length > 0 &&
          missingAired.every((e) => e.monitored);
        if (!existing.monitored) {
          // A disabled series has no effective episode monitoring. Clear dormant
          // flags before enabling it so unrelated downloads cannot reactivate.
          mutating = true;
          result.libraryChanged = null;
          await arr.api(
            `series/${existing.id}`,
            "PUT",
            {
              ...existing,
              monitored: false,
              monitorNewItems: "none",
              seasons: existing.seasons.map((s) => ({
                ...s,
                monitored: false,
              })),
            },
            signal,
          );
          result.libraryChanged = true;
          episodes = await arr.episodes(existing.id, signal);
          const dormant = episodes.filter((e) => e.monitored).map((e) => e.id!);
          if (dormant.length) {
            result.libraryChanged = null;
            await arr.api(
              "episode/monitor",
              "PUT",
              { episodeIds: dormant, monitored: false },
              signal,
            );
            result.libraryChanged = true;
          }
          existing = storedItemSchema.parse(
            await arr.api(`series/${existing.id}`, "GET", undefined, signal),
          );
          episodes = await arr.episodes(existing.id, signal);
          if (
            existing.monitored ||
            existing.monitorNewItems !== "none" ||
            existing.qualityProfileId !== profile.id ||
            existing.seasons.some((s) => s.monitored) ||
            episodes.some((e) => e.monitored)
          ) {
            throw new MediaError("monitoring_changed_during_request");
          }
        }
        if (
          !existing.monitored ||
          existing.seasons.some(
            (s) => seasons.has(s.seasonNumber) && s.monitored,
          )
        ) {
          mutating = true;
          result.libraryChanged = null;
          await arr.api(
            `series/${existing.id}`,
            "PUT",
            {
              ...existing,
              monitored: true,
              seasons: existing.seasons.map((s) =>
                seasons.has(s.seasonNumber) ? { ...s, monitored: false } : s,
              ),
            },
            signal,
          );
          result.libraryChanged = true;
        }
        episodes = await arr.episodes(existing.id, signal);
        const selected = episodes.filter((e) => seasons.has(e.seasonNumber));
        const missing = selected.filter((e) => hasAired(e, now) && !e.hasFile);
        // Disable any previously enabled unaired episode in the selected seasons.
        const off = selected
          .filter((e) => !hasAired(e, now) && e.monitored)
          .map((e) => e.id!);
        const on = selected
          .filter((e) => hasAired(e, now) && !e.monitored)
          .map((e) => e.id!);
        for (const [ids, monitored] of [
          [off, false],
          [on, true],
        ] as const) {
          if (!ids.length) continue;
          mutating = true;
          result.libraryChanged = null;
          await arr.api(
            "episode/monitor",
            "PUT",
            { episodeIds: ids, monitored },
            signal,
          );
          result.libraryChanged = true;
        }
        if (alreadyRequested)
          return {
            ...result,
            outcome: "already_requested",
            message:
              "The aired missing episodes are already monitored; no new search was started.",
          };
        if (!missing.length)
          return {
            ...result,
            outcome: "already_available",
            message: "All aired episodes are now available.",
          };
        const command = await arr.api(
          "command",
          "POST",
          { name: "EpisodeSearch", episodeIds: missing.map((e) => e.id!) },
          signal,
        );
        result.commandId = z.object({ id: z.number() }).parse(command).id;
      }
      return {
        ...result,
        outcome: "accepted",
        searchStarted: true,
        searchStatus: "queued",
        message:
          "Monitoring was updated and a download search was queued. This does not confirm a download or availability.",
      };
    } catch (error) {
      return {
        ...result,
        outcome: mutating ? "partial_failure" : "failed",
        searchStatus: mutating ? "unknown" : "not_started",
        message: mutating
          ? "The request did not finish. Library changes may have succeeded; inspect details before retrying. Search submission was not confirmed."
          : "The backend could not complete the request; no library changes were attempted.",
        error:
          error instanceof MediaError ? error.code : "invalid_backend_response",
      };
    }
  }
  private async checkRoot(arr: Arr, signal?: AbortSignal) {
    const roots = z
      .array(z.object({ path: z.string() }))
      .parse(await arr.api("rootfolder", "GET", undefined, signal));
    if (!roots.some((r) => r.path === arr.endpoint.rootFolder))
      throw new MediaError("configured_root_unavailable");
  }
}
