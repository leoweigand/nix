import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { MediaService, requestSchema, searchSchema } from "./media.ts";

const now = Date.parse("2026-11-01T10:00:00Z");
const movie = {
  id: 0,
  title: "Test Movie",
  year: 2020,
  tmdbId: 100,
  monitored: false,
  hasFile: false,
  qualityProfileId: 1,
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
    failCommand: false,
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
      }
      return reply(state.shows[0]);
    }
    if (path === "episode") return reply(state.episodes);
    if (path === "episode/monitor") {
      for (const e of state.episodes)
        if (body.episodeIds.includes(e.id)) e.monitored = body.monitored;
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
test("TV requests refuse to activate unrelated monitoring on a disabled series", async (t) => {
  const { service, state } = await fixture(t);
  state.shows.push({
    ...structuredClone(show),
    id: 22,
    monitored: false,
    monitorNewItems: "all",
  });
  const result = await service.request(
    request("tv:tvdb:200", { seasons: [1] }),
  );
  assert.equal(result.outcome, "needs_input");
  assert.equal(state.writes.length, 0);
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
