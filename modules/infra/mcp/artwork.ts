import type { MediaSummary } from "./contracts.ts";

const artworkHosts = new Set([
  "image.tmdb.org",
  "artworks.thetvdb.com",
  "assets.fanart.tv",
  "images.fanart.tv",
]);
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function artworkUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      artworkHosts.has(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    )
      return url.href;
  } catch {
    /* Missing or private artwork is represented as null. */
  }
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function date(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value))
    return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
export function mediaMetadata(
  item: Record<string, unknown>,
  type: "movie" | "tv",
) {
  const images = Array.isArray(item.images)
    ? item.images.map(record).filter((value) => value !== undefined)
    : [];
  const image = (
    kind: "poster" | "backdrop",
  ): MediaSummary["images"]["poster"] => {
    for (const entry of images.filter(
      (entry) =>
        entry.coverType === (kind === "poster" ? "poster" : "fanart") ||
        entry.coverType === kind,
    )) {
      const url = artworkUrl(entry.remoteUrl) ?? artworkUrl(entry.url);
      if (!url) continue;
      return describeImage(url, kind, entry);
    }
    const fallback =
      kind === "poster" ? artworkUrl(item.remotePoster) : undefined;
    return fallback ? describeImage(fallback, kind, {}) : null;
  };
  const describeImage = (
    url: string,
    kind: string,
    entry: Record<string, unknown>,
  ) => {
    const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
    const mimeType = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
      avif: "image/avif",
    }[extension ?? ""];
    return {
      url,
      alt: `${item.title}${positiveInteger(item.year) ? ` (${item.year})` : ""} ${kind}`,
      ...(positiveInteger(entry.width) ? { width: entry.width } : {}),
      ...(positiveInteger(entry.height) ? { height: entry.height } : {}),
      ...(mimeType
        ? {
            mimeType: mimeType as NonNullable<
              MediaSummary["images"]["poster"]
            >["mimeType"],
          }
        : {}),
    };
  };
  const releaseDates: MediaSummary["releaseDates"] = [];
  for (const [key, releaseType] of [
    ["inCinemas", "cinema"],
    ["digitalRelease", "digital"],
    ["physicalRelease", "physical"],
    ["firstAired", "first_aired"],
    ["lastAired", "last_aired"],
  ] as const) {
    const parsed = date(item[key]);
    if (parsed) releaseDates.push({ type: releaseType, date: parsed });
  }
  const links: MediaSummary["links"] = [];
  if (positiveInteger(item.tmdbId))
    links.push({
      provider: "tmdb",
      url: `https://www.themoviedb.org/${type === "movie" ? "movie" : "tv"}/${item.tmdbId}`,
    });
  if (type === "tv" && positiveInteger(item.tvdbId))
    links.push({
      provider: "tvdb",
      url: `https://thetvdb.com/dereferrer/series/${item.tvdbId}`,
    });
  if (typeof item.imdbId === "string" && /^tt\d{7,10}$/.test(item.imdbId))
    links.push({
      provider: "imdb",
      url: `https://www.imdb.com/title/${item.imdbId}/`,
    });
  return {
    images: { poster: image("poster"), backdrop: image("backdrop") },
    runtimeMinutes:
      typeof item.runtime === "number" &&
      item.runtime > 0 &&
      Number.isFinite(item.runtime)
        ? item.runtime
        : null,
    genres: Array.isArray(item.genres)
      ? item.genres.filter(
          (genre): genre is string =>
            typeof genre === "string" && genre.trim().length > 0,
        )
      : [],
    certification:
      typeof item.certification === "string" ? item.certification : null,
    status: typeof item.status === "string" ? item.status : null,
    releaseDate:
      type === "movie"
        ? (date(item.releaseDate) ??
          date(item.inCinemas) ??
          date(item.digitalRelease) ??
          date(item.physicalRelease))
        : date(item.firstAired),
    releaseDates,
    links,
  };
}
