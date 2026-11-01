import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { MediaService, requestSchema, searchSchema } from "./media.ts";
import {
  searchOutputSchema,
  detailsOutputSchema,
  requestOutputSchema,
  detailsSchema,
} from "./contracts.ts";
import { progressSchema, progressOutputSchema } from "./progress.ts";
import { TransferService } from "./transfer.ts";
import { mediaMetadata } from "./artwork.ts";

const now = Date.parse("2026-11-01T10:00:00Z");
const movie = {
  id: 0,
  title: "Test Movie",
  year: 2020,
  tmdbId: 100,
  monitored: false,
  hasFile: false,
  qualityProfileId: 1,
  runtime: 123,
  genres: ["Science Fiction", "Adventure"],
  status: "released",
  certification: "PG-13",
  imdbId: "tt1234567",
  releaseDate: "2020-03-01T00:00:00Z",
  inCinemas: "2020-02-01T00:00:00Z",
  images: [
    {
      coverType: "poster",
      url: "/MediaCover/11/poster.jpg?apikey=fixture-key",
      remoteUrl: "https://image.tmdb.org/t/p/w500/poster.jpg",
      width: 500,
      height: 750,
    },
    {
      coverType: "fanart",
      url: "https://image.tmdb.org/t/p/original/backdrop.jpg",
    },
  ],
};
const show = {
  id: 0,
  title: "Test Show",
  year: 2020,
  tvdbId: 200,
  monitored: true,
  qualityProfileId: 1,
  monitorNewItems: "none",
  seasons: [
    { seasonNumber: 1, monitored: false },
    { seasonNumber: 2, monitored: false },
  ],
};
const episodes = [
  {
    id: 1,
    seasonNumber: 1,
    episodeNumber: 1,
    airDateUtc: "2020-01-01T00:00:00Z",
    hasFile: false,
    monitored: false,
  },
  {
    id: 2,
    seasonNumber: 1,
    episodeNumber: 2,
    airDateUtc: "2020-01-02T00:00:00Z",
    hasFile: true,
    monitored: false,
  },
  {
    id: 3,
    seasonNumber: 1,
    episodeNumber: 3,
    airDateUtc: "2027-01-01T00:00:00Z",
    hasFile: false,
    monitored: false,
  },
  {
    id: 4,
    seasonNumber: 1,
    episodeNumber: 4,
    hasFile: false,
    monitored: false,
  },
  {
    id: 5,
    seasonNumber: 2,
    episodeNumber: 1,
    airDateUtc: "2020-01-03T00:00:00Z",
    hasFile: false,
    monitored: false,
  },
];
async function fixture(t: TestContext) {
  const state = {
    movies: [] as Record<string, any>[],
    shows: [] as Record<string, any>[],
    episodes: structuredClone(episodes),
    writes: [] as { path: string; body: any }[],
    enableSnapshots: [] as {
      monitoredEpisodeIds: number[];
      seasons: boolean[];
      monitorNewItems: string;
    }[],
    queue: [] as Record<string, any>[],
    failQueue: false,
    ignoreQueueFilter: false,
    reads: [] as string[],
    failCommand: false,
    failEpisodeMonitor: false,
    changeMonitoringAfterReset: false,
    failLookup: false,
    failTv: false,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    res.setHeader("Content-Type", "application/json");
    const reply = (data: unknown, code = 200) => {
      res.writeHead(code);
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/metadata/200") {
      assert.equal(req.headers["x-api-key"], undefined);
      return reply({
        episodes: state.episodes.map((e) => ({
          ...e,
          id: undefined,
          hasFile: false,
          monitored: false,
        })),
      });
    }
    if (req.headers["x-api-key"] !== "fixture-key") return reply({}, 401);
    const path = url.pathname.replace(/^\/api\/v3\//, "");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : undefined;
    if (req.method !== "GET") state.writes.push({ path, body });
    else state.reads.push(req.url!);
    if (path === "queue") {
      if (
        state.failQueue ||
        (state.failTv && url.searchParams.has("includeSeries"))
      )
        return reply({}, 503);
      const id =
        url.searchParams.get("movieIds") ?? url.searchParams.get("seriesIds");
      const all = state.queue.filter((item) =>
        url.searchParams.has("includeMovie") ? item.movieId : item.seriesId,
      );
      const records =
        id && !state.ignoreQueueFilter
          ? all.filter((item) => String(item.movieId ?? item.seriesId) === id)
          : all;
      return reply({
        totalRecords: records.length,
        records: records.slice(0, Number(url.searchParams.get("pageSize"))),
      });
    }
    if (state.failTv && path.startsWith("series")) return reply({}, 503);
    if (path === "qualityprofile")
      return reply([
        { id: 1, name: "HD" },
        { id: 2, name: "4K preferred" },
      ]);
    if (path === "rootfolder")
      return reply([{ path: "/movies" }, { path: "/tv" }]);
    if (path === "movie/lookup")
      return state.failLookup ? reply({}, 503) : reply([movie]);
    if (path === "series/lookup") return reply([show]);
    if (path === "movie" || path === "series") {
      const list = path === "movie" ? state.movies : state.shows;
      if (req.method === "GET") return reply(list);
      const added = { ...body, id: path === "movie" ? 11 : 22 };
      list.push(added);
      return reply(added, 201);
    }
    if (path === "movie/11") {
      if (req.method === "PUT") state.movies[0] = body;
      return reply(state.movies[0]);
    }
    if (path === "series/22") {
      if (req.method === "PUT") {
        const enabling = body.monitored && !state.shows[0].monitored;
        // Sonarr propagates changed season flags to all episodes in that season.
        for (const season of body.seasons) {
          const old = state.shows[0].seasons.find(
            (s: { seasonNumber: number }) =>
              s.seasonNumber === season.seasonNumber,
          );
          if (old?.monitored !== season.monitored)
            for (const e of state.episodes) {
              if (e.seasonNumber === season.seasonNumber)
                e.monitored = season.monitored;
            }
        }
        state.shows[0] = body;
        if (enabling)
          state.enableSnapshots.push({
            monitoredEpisodeIds: state.episodes
              .filter((e) => e.monitored)
              .map((e) => e.id),
            seasons: body.seasons.map(
              (s: { monitored: boolean }) => s.monitored,
            ),
            monitorNewItems: body.monitorNewItems,
          });
      }
      return reply(state.shows[0]);
    }
    if (path === "episode") return reply(state.episodes);
    if (path === "episode/monitor") {
      if (state.failEpisodeMonitor) return reply({}, 503);
      for (const e of state.episodes)
        if (body.episodeIds.includes(e.id)) e.monitored = body.monitored;
      if (!body.monitored && state.changeMonitoringAfterReset) {
        state.shows[0].monitored = true;
        state.episodes[4].monitored = true;
      }
      return reply([]);
    }
    if (path === "command")
      return state.failCommand
        ? reply({}, 503)
        : reply({ id: 77, status: "queued" }, 201);
    return reply({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const service = new MediaService(
    {
      radarr: { url: base, apiKey: "fixture-key", rootFolder: "/movies" },
      sonarr: { url: base, apiKey: "fixture-key", rootFolder: "/tv" },
    },
    { now: () => now, metadataBase: `${base}/metadata` },
  );
  return { service, state };
}
const request = (mediaId: string, extra: Record<string, unknown> = {}) =>
  requestSchema.parse({ mediaId, ...extra });

test("request schema requires explicit unique TV seasons and forbids movie seasons", () => {
  for (const input of [
    { mediaId: "tv:tvdb:200" },
    { mediaId: "movie:tmdb:100", seasons: [1] },
    { mediaId: "tv:tvdb:200", seasons: [1, 1] },
    { mediaId: "movie:tmdb:100", future: true },
    { mediaId: "movie:tmdb:../etc" },
  ])
    assert.equal(requestSchema.safeParse(input).success, false);
  assert.equal(request("movie:tmdb:100").qualityProfile, "HD");
});
test("search combines catalog results with actual library state, with bounded mixed results", async (t) => {
  const { service, state } = await fixture(t);
  state.movies.push({ ...movie, id: 11, hasFile: true });
  const result = await service.search(
    searchSchema.parse({ query: "Test", limit: 2 }),
  );
  assert.deepEqual(
    result.results.map((r) => [r.mediaId, r.libraryStatus]),
    [
      ["movie:tmdb:100", "available"],
      ["tv:tvdb:200", "not_requested"],
    ],
  );
  assert.equal(state.writes.length, 0);
  state.shows.push({
    ...structuredClone(show),
    id: 22,
    statistics: { episodeFileCount: 5, totalEpisodeCount: 5 },
  });
  const complete = await service.search(
    searchSchema.parse({ query: "Test", type: "tv" }),
  );
  assert.equal(complete.results[0].libraryStatus, "available");
  state.failTv = true;
  const partial = await service.search(searchSchema.parse({ query: "Test" }));
  assert.equal(partial.results.length, 1);
  assert.equal(partial.errors[0].type, "tv");
});
test("new TV details provide aired counts without adding a series or leaking API keys to metadata", async (t) => {
  const { service, state } = await fixture(t);
  const details = await service.details("tv:tvdb:200");
  assert.deepEqual(details.qualityProfiles, ["HD", "4K preferred"]);
  assert.deepEqual(details.seasons?.[0], {
    seasonNumber: 1,
    monitored: false,
    totalEpisodes: 4,
    airedEpisodes: 2,
    availableEpisodes: 0,
    missingEpisodes: 2,
    monitoredEpisodes: 0,
    alreadyAvailable: false,
    alreadyRequested: false,
    canRequest: true,
  });
  assert.equal(state.writes.length, 0);
});
test("movie requests use HD, fixed roots and a separate search command; parallel repeats do not duplicate", async (t) => {
  const { service, state } = await fixture(t);
  const results = await Promise.all([
    service.request(request("movie:tmdb:100")),
    service.request(request("movie:tmdb:100")),
  ]);
  assert.deepEqual(
    results.map((r) => r.outcome),
    ["accepted", "already_requested"],
  );
  assert.equal(state.movies.length, 1);
  assert.equal(state.movies[0].qualityProfileId, 1);
  assert.equal(state.movies[0].rootFolderPath, "/movies");
  assert.equal(state.movies[0].addOptions.searchForMovie, false);
  assert.deepEqual(state.writes.find((w) => w.path === "command")?.body, {
    name: "MoviesSearch",
    movieIds: [11],
  });
  assert.equal(state.writes.filter((w) => w.path === "command").length, 1);
});
test("all configured profiles can be requested, but existing profiles cannot be silently changed", async (t) => {
  const { service, state } = await fixture(t);
  const created = await service.request(
    request("movie:tmdb:100", { qualityProfile: "4K preferred" }),
  );
  assert.equal(created.outcome, "accepted");
  assert.equal(state.movies[0].qualityProfileId, 2);
  const count = state.writes.length;
  assert.equal(
    (await service.request(request("movie:tmdb:100"))).outcome,
    "needs_input",
  );
  assert.equal(
    (
      await service.request(
        request("movie:tmdb:100", { qualityProfile: "invented" }),
      )
    ).outcome,
    "needs_input",
  );
  assert.equal(state.writes.length, count);
});
test("TV adds with future monitoring disabled and searches only aired missing IDs", async (t) => {
  const { service, state } = await fixture(t);
  const result = await service.request(
    request("tv:tvdb:200", { seasons: [1] }),
  );
  assert.equal(result.outcome, "accepted");
  assert.equal(result.searchStarted, true);
  assert.equal(state.shows[0].monitorNewItems, "none");
  assert(
    state.shows[0].seasons.every((s: { monitored: boolean }) => !s.monitored),
  );
  assert.equal(state.shows[0].addOptions.monitor, "none");
  assert.equal(state.shows[0].addOptions.searchForMissingEpisodes, false);
  assert.deepEqual(
    state.episodes.map((e) => e.monitored),
    [true, true, false, false, false],
  );
  assert.deepEqual(state.writes.find((w) => w.path === "command")?.body, {
    name: "EpisodeSearch",
    episodeIds: [1],
  });
  assert.equal(
    (await service.request(request("tv:tvdb:200", { seasons: [1] }))).outcome,
    "already_requested",
  );
  assert.equal(state.writes.filter((w) => w.path === "command").length, 1);
});
test("TV updates preserve unselected seasons and prevent later episode discovery from enabling selected seasons", async (t) => {
  const { service, state } = await fixture(t);
  state.shows.push({
    ...structuredClone(show),
    id: 22,
    monitorNewItems: "all",
    seasons: [
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: true },
    ],
  });
  state.episodes[2].monitored = true;
  state.episodes[4].monitored = true;
  const result = await service.request(
    request("tv:tvdb:200", { seasons: [1] }),
  );
  assert.equal(result.outcome, "accepted");
  assert.deepEqual(
    state.shows[0].seasons.map((s: { monitored: boolean }) => s.monitored),
    [false, true],
  );
  assert.equal(state.shows[0].monitorNewItems, "all");
  assert.deepEqual(
    state.episodes.map((e) => e.monitored),
    [true, true, false, false, true],
  );
});
test("TV requests activate disabled series without reviving dormant episode or future-season monitoring", async (t) => {
  const { service, state } = await fixture(t);
  state.shows.push({
    ...structuredClone(show),
    id: 22,
    monitored: false,
    monitorNewItems: "all",
    seasons: [
      { seasonNumber: 1, monitored: true },
      { seasonNumber: 2, monitored: false },
    ],
  });
  // Season two is off but still has an individually monitored episode. Both
  // season-level and individual dormant flags must be cleared before activation.
  state.episodes[0].monitored = true;
  state.episodes[2].monitored = true;
  state.episodes[3].monitored = true;
  state.episodes[4].monitored = true;
  const result = await service.request(
    request("tv:tvdb:200", { seasons: [1] }),
  );
  assert.equal(result.outcome, "accepted");
  assert.equal(result.searchStarted, true);
  assert.equal(state.shows[0].monitored, true);
  assert.deepEqual(state.enableSnapshots, [
    {
      monitoredEpisodeIds: [],
      seasons: [false, false],
      monitorNewItems: "none",
    },
  ]);
  assert.deepEqual(
    state.episodes.map((e) => e.monitored),
    [true, true, false, false, false],
  );
  assert.deepEqual(state.writes.find((w) => w.path === "command")?.body, {
    name: "EpisodeSearch",
    episodeIds: [1],
  });
  assert.equal(
    (await service.request(request("tv:tvdb:200", { seasons: [1] }))).outcome,
    "already_requested",
  );
  assert.equal(state.writes.filter((w) => w.path === "command").length, 1);
});
test("failed dormant-flag cleanup leaves the series disabled and never starts a search", async (t) => {
  const { service, state } = await fixture(t);
  state.shows.push({
    ...structuredClone(show),
    id: 22,
    monitored: false,
    monitorNewItems: "all",
  });
  state.episodes[4].monitored = true;
  state.failEpisodeMonitor = true;
  const result = await service.request(
    request("tv:tvdb:200", { seasons: [1] }),
  );
  assert.equal(result.outcome, "partial_failure");
  assert.equal(state.shows[0].monitored, false);
  assert.equal(state.enableSnapshots.length, 0);
  assert.equal(
    state.writes.some((w) => w.path === "command"),
    false,
  );
});
test("a concurrent monitoring change aborts normalization before requesting any search", async (t) => {
  const { service, state } = await fixture(t);
  state.shows.push({
    ...structuredClone(show),
    id: 22,
    monitored: false,
    monitorNewItems: "all",
  });
  state.episodes[4].monitored = true;
  state.changeMonitoringAfterReset = true;
  const result = await service.request(
    request("tv:tvdb:200", { seasons: [1] }),
  );
  assert.equal(result.outcome, "partial_failure");
  assert("error" in result);
  assert.equal(result.error, "monitoring_changed_during_request");
  assert.equal(state.enableSnapshots.length, 0);
  assert.equal(
    state.writes.some((w) => w.path === "command"),
    false,
  );
});
test("invalid or entirely unaired seasons cause no library mutations", async (t) => {
  const { service, state } = await fixture(t);
  assert.equal(
    (await service.request(request("tv:tvdb:200", { seasons: [99] }))).outcome,
    "needs_input",
  );
  state.episodes[4].airDateUtc = "2027-01-01T00:00:00Z";
  assert.equal(
    (await service.request(request("tv:tvdb:200", { seasons: [2] }))).outcome,
    "needs_input",
  );
  assert.equal(state.writes.length, 0);
});
test("already available media is a no-op", async (t) => {
  const { service, state } = await fixture(t);
  state.movies.push({ ...movie, id: 11, hasFile: true });
  assert.equal(
    (await service.request(request("movie:tmdb:100"))).outcome,
    "already_available",
  );
  state.shows.push({ ...structuredClone(show), id: 22 });
  state.episodes[0].hasFile = true;
  assert.equal(
    (await service.request(request("tv:tvdb:200", { seasons: [1] }))).outcome,
    "already_available",
  );
  assert.equal(state.writes.length, 0);
});
test("search submission failures explicitly preserve partial library success without claiming downloads", async (t) => {
  const { service, state } = await fixture(t);
  state.failCommand = true;
  const result = await service.request(request("movie:tmdb:100"));
  assert.equal(result.outcome, "partial_failure");
  assert.equal(result.libraryChanged, true);
  assert.equal(result.searchStarted, false);
  assert.equal(result.searchStatus, "unknown");
  assert.equal(state.movies.length, 1);
  assert(!JSON.stringify(result).includes("fixture-key"));
});

test("search returns public artwork, release facts and complete read actions without exposing private URLs", async (t) => {
  const { service, state } = await fixture(t);
  const result = searchOutputSchema.parse(
    await service.search(searchSchema.parse({ query: "Test", type: "movie" })),
  );
  const item = result.results[0];
  assert.deepEqual(item.images.poster, {
    url: "https://image.tmdb.org/t/p/w500/poster.jpg",
    alt: "Test Movie (2020) poster",
    width: 500,
    height: 750,
    mimeType: "image/jpeg",
  });
  assert.equal(
    item.images.backdrop?.url,
    "https://image.tmdb.org/t/p/original/backdrop.jpg",
  );
  assert.equal(item.runtimeMinutes, 123);
  assert.deepEqual(item.genres, ["Science Fiction", "Adventure"]);
  assert.equal(item.status, "released");
  assert.equal(item.releaseDate, "2020-03-01T00:00:00.000Z");
  assert.deepEqual(item.releaseDates, [
    { type: "cinema", date: "2020-02-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(item.links, [
    { provider: "tmdb", url: "https://www.themoviedb.org/movie/100" },
    { provider: "imdb", url: "https://www.imdb.com/title/tt1234567/" },
  ]);
  assert.equal(item.canRequest, true);
  assert.equal(item.alreadyAvailable, false);
  assert.equal(item.availableActions.length, 1);
  assert.equal(item.availableActions[0].tool, "get_media_details");
  assert.deepEqual(detailsSchema.parse(item.availableActions[0].arguments), {
    mediaId: item.mediaId,
  });
  assert(!JSON.stringify(result).includes("MediaCover"));
  assert(!JSON.stringify(result).includes("fixture-key"));
  assert.equal(state.writes.length, 0);
});

test("movie details offer an executable default request action, preserve existing profiles and omit fulfilled actions", async (t) => {
  const { service, state } = await fixture(t);
  const details = detailsOutputSchema.parse(
    await service.details("movie:tmdb:100"),
  );
  const action = details.availableActions[0];
  assert.equal(action.tool, "request_media");
  const args = requestSchema.parse(action.arguments);
  assert.deepEqual(args, { mediaId: "movie:tmdb:100", qualityProfile: "HD" });
  assert.equal(state.writes.length, 0);
  const result = requestOutputSchema.parse(await service.request(args));
  assert.equal(result.outcome, "accepted");
  assert.equal(result.availableActions[0].tool, "get_media_details");
  assert.deepEqual(
    (await service.details("movie:tmdb:100")).availableActions,
    [],
  );
  state.movies[0].monitored = false;
  state.movies[0].qualityProfileId = 2;
  const existing = await service.details("movie:tmdb:100");
  assert.equal(
    requestSchema.parse(existing.availableActions[0].arguments).qualityProfile,
    "4K preferred",
  );
  state.movies[0].hasFile = true;
  const available = await service.details("movie:tmdb:100");
  assert.equal(available.alreadyAvailable, true);
  assert.equal(available.canRequest, false);
  assert.deepEqual(available.availableActions, []);
});

test("TV actions identify requestable aired seasons and never offer entirely unaired or already monitored seasons", async (t) => {
  const { service, state } = await fixture(t);
  state.episodes[4].airDateUtc = "2027-01-01T00:00:00Z";
  const details = detailsOutputSchema.parse(
    await service.details("tv:tvdb:200"),
  );
  assert.equal(details.availableActions.length, 1);
  assert.deepEqual(requestSchema.parse(details.availableActions[0].arguments), {
    mediaId: "tv:tvdb:200",
    qualityProfile: "HD",
    seasons: [1],
  });
  assert.equal(details.seasons?.[1].canRequest, false);
  state.shows.push({ ...structuredClone(show), id: 22 });
  state.episodes[0].monitored = true;
  const monitored = await service.details("tv:tvdb:200");
  assert.equal(monitored.seasons?.[0].alreadyRequested, true);
  assert.deepEqual(monitored.availableActions, []);
  state.shows[0].monitored = false;
  const disabled = await service.details("tv:tvdb:200");
  assert.equal(disabled.alreadyRequested, false);
  assert.equal(disabled.availableActions.length, 1);
  assert.equal(state.writes.length, 0);
});

test("optional metadata degrades to null and untrusted or private artwork never becomes a client image URL", () => {
  const result = mediaMetadata(
    {
      title: "Unknown",
      year: 0,
      runtime: -1,
      firstAired: "not a date",
      genres: null,
      imdbId: "tt1234567/../../secret",
      images: [
        null,
        { coverType: "poster", url: "http://127.0.0.1/private.jpg" },
        {
          coverType: "poster",
          url: "https://image.tmdb.org@evil.example/image.jpg",
        },
        {
          coverType: "fanart",
          url: "https://user:password@image.tmdb.org/private.jpg",
        },
      ],
      remotePoster: "https://artworks.thetvdb.com/banners/poster.webp",
    },
    "tv",
  );
  assert.deepEqual(result.images.poster, {
    url: "https://artworks.thetvdb.com/banners/poster.webp",
    alt: "Unknown poster",
    mimeType: "image/webp",
  });
  assert.equal(result.images.backdrop, null);
  assert.equal(result.releaseDate, null);
  assert.equal(result.runtimeMinutes, null);
  assert.deepEqual(result.links, []);
  assert.deepEqual(result.genres, []);
  assert.deepEqual(mediaMetadata({ title: "Unknown" }, "movie").images, {
    poster: null,
    backdrop: null,
  });
});

const downloadingMovie = {
  id: 1,
  movieId: 11,
  movie: { tmdbId: 100, title: "Test Movie" },
  size: 1000,
  sizeleft: 250,
  status: "downloading",
  trackedDownloadStatus: "ok",
  trackedDownloadState: "downloading",
  estimatedCompletionTime: "2026-11-01T11:00:00Z",
  protocol: "torrent",
  outputPath: "/secret/path",
  downloadId: "private-hash",
  title: "private-release-name",
};
test("progress reads a bounded snapshot, computes download percent and omits private backend details", async (t) => {
  const { service, state } = await fixture(t);
  state.queue.push(downloadingMovie, { ...downloadingMovie, id: 2 });
  const result = progressOutputSchema.parse(
    await service.progress(progressSchema.parse({ limit: 1 })),
  );
  assert.equal(result.sources[0].total, 2);
  assert.equal(result.sources[0].truncated, true);
  const entry = result.sources[0].entries[0];
  assert.equal(entry.downloadPercent, 75);
  assert.equal(entry.progressSummary, "Torrent is 75% downloaded");
  assert.equal(
    entry.estimatedCompletionTime,
    downloadingMovie.estimatedCompletionTime,
  );
  assert.equal(entry.title, "Test Movie");
  assert.equal(result.sources[1].total, 0);
  assert.equal(result.observedAt, new Date(now).toISOString());
  assert(!JSON.stringify(result).includes("private-"));
  assert(!JSON.stringify(result).includes("/secret"));
  assert.equal(state.reads.length, 2);
  assert.deepEqual(state.writes, []);
});
test("progress filters title in backend and rejects ignored filters; unknown library title never queries all downloads", async (t) => {
  const { service, state } = await fixture(t);
  state.movies.push({ ...movie, id: 11 });
  state.queue.push(downloadingMovie, {
    ...downloadingMovie,
    id: 2,
    movieId: 99,
  });
  const result = await service.progress(
    progressSchema.parse({ mediaId: "movie:tmdb:100" }),
  );
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].total, 1);
  assert(state.reads.some((url) => url.includes("movieIds=11")));
  state.ignoreQueueFilter = true;
  assert.deepEqual(
    (
      await service.progress(
        progressSchema.parse({ mediaId: "movie:tmdb:100" }),
      )
    ).errors,
    [{ type: "movie", error: "queue_unavailable" }],
  );
  state.reads.length = 0;
  const missing = await service.progress(
    progressSchema.parse({ mediaId: "movie:tmdb:999" }),
  );
  assert.equal(missing.sources[0].total, 0);
  assert(!state.reads.some((url) => url.includes("queue")));
  assert.deepEqual(state.writes, []);
});
test("completed TV download retains import warning and episode identity without claiming library availability", async (t) => {
  const { service, state } = await fixture(t);
  state.shows.push({ ...show, id: 22 });
  state.queue.push({
    id: 3,
    seriesId: 22,
    series: { tvdbId: 200, title: "Test Show" },
    episode: { seasonNumber: 2, episodeNumber: 1 },
    size: 100,
    sizeleft: 0,
    status: "completed",
    trackedDownloadStatus: "warning",
    trackedDownloadState: "importPending",
    errorMessage: "/secret/import/path",
  });
  const result = progressOutputSchema.parse(
    await service.progress(progressSchema.parse({ mediaId: "tv:tvdb:200" })),
  );
  const entry = result.sources[0].entries[0];
  assert.equal(entry.downloadPercent, 100);
  assert.equal(entry.trackedDownloadState, "importPending");
  assert.equal(entry.hasIssue, true);
  assert.equal(entry.seasonNumber, 2);
  assert.equal(entry.episodeNumber, 1);
  assert(!JSON.stringify(result).includes("/secret"));
  assert.deepEqual(state.writes, []);
});
test("progress distinguishes queue outages from an empty queue and preserves the working source", async (t) => {
  const { service, state } = await fixture(t);
  state.failTv = true;
  const partial = await service.progress(progressSchema.parse({}));
  assert.deepEqual(partial.errors, [
    { type: "tv", error: "queue_unavailable" },
  ]);
  assert.equal(partial.sources.length, 1);
  state.failQueue = true;
  const failed = await service.progress(progressSchema.parse({}));
  assert.equal(failed.errors.length, 2);
  assert.deepEqual(failed.sources, []);
});
test("unknown or inconsistent byte counts and invalid ETAs remain unknown", async (t) => {
  const { service, state } = await fixture(t);
  for (const bytes of [
    {},
    { size: 0, sizeleft: 0 },
    { size: 100, sizeleft: 101 },
  ]) {
    state.queue = [
      {
        ...downloadingMovie,
        size: undefined,
        sizeleft: undefined,
        ...bytes,
        estimatedCompletionTime: "unknown",
      },
    ];
    const result = progressOutputSchema.parse(
      await service.progress(progressSchema.parse({})),
    );
    assert.equal(result.sources[0].entries[0].downloadPercent, null);
    assert.equal(result.sources[0].entries[0].estimatedCompletionTime, null);
  }
});

test("completed torrents report Syncthing transfer stages and skip Syncthing for incomplete downloads", async (t) => {
  const { service, state } = await fixture(t);
  let calls = 0;
  const transfer = new TransferService({
    url: "http://127.0.0.1:1",
    apiKey: "unused",
    folder: "fixture",
  });
  transfer.states = async (paths) => {
    calls++;
    assert.equal(
      paths.get("movie:1"),
      "/media/sources/seedbox/deluge/radarr/Movie",
    );
    return new Map([["movie:1", "transferring_to_server"]]);
  };
  const withTransfer = new MediaService(
    { radarr: service.movie.endpoint, sonarr: service.tv.endpoint },
    { now: () => now, transfer },
  );
  state.queue.push({
    ...downloadingMovie,
    outputPath: "/media/sources/seedbox/deluge/radarr/Movie",
  });
  await withTransfer.progress(progressSchema.parse({}));
  assert.equal(calls, 0);
  state.queue[0].sizeleft = 0;
  state.queue[0].status = "completed";
  const result = progressOutputSchema.parse(
    await withTransfer.progress(progressSchema.parse({})),
  );
  assert.equal(calls, 1);
  assert.equal(
    result.sources[0].entries[0].progressSummary,
    "Torrent is on the seedbox, currently downloading to the server",
  );
});
test("a nearly completed torrent cannot round up to a completed transfer stage", async (t) => {
  const { service, state } = await fixture(t);
  state.queue.push({ ...downloadingMovie, size: 100000, sizeleft: 1 });
  const result = await service.progress(progressSchema.parse({}));
  assert.equal(result.sources[0].entries[0].downloadPercent, 99.9);
});
