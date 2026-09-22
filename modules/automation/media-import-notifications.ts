type Environment = Record<string, string | undefined>;

function value(
  environment: Environment,
  lower: string,
  upper: string,
): string | undefined {
  return environment[lower] ?? environment[upper];
}

function isUpgrade(
  environment: Environment,
  lower: string,
  upper: string,
): boolean {
  return value(environment, lower, upper)?.toLowerCase() === "true";
}

function stripTrailingYear(title: string): string {
  return title.replace(/\s\([0-9]{4}\)$/, "");
}

function episodeLabel(season: string, episodes: string): string {
  const pad = (number: string) => number.padStart(2, "0");
  return `S${pad(season)}${
    episodes.split(",").map((episode) => `E${pad(episode)}`).join(", ")
  }`;
}

export function notificationMessage(
  environment: Environment,
): string | undefined {
  const radarrEvent = value(
    environment,
    "radarr_eventtype",
    "Radarr_EventType",
  );
  if (radarrEvent !== undefined) {
    if (
      radarrEvent !== "Download" ||
      isUpgrade(environment, "radarr_isupgrade", "Radarr_IsUpgrade")
    ) {
      return undefined;
    }

    const title = value(
      environment,
      "radarr_movie_title",
      "Radarr_Movie_Title",
    );
    if (!title) throw new Error("missing Radarr movie title");
    return `🎬 New movie: ${stripTrailingYear(title)}`;
  }

  const sonarrEvent = value(
    environment,
    "sonarr_eventtype",
    "Sonarr_EventType",
  );
  if (sonarrEvent !== undefined) {
    if (
      sonarrEvent !== "Download" ||
      isUpgrade(environment, "sonarr_isupgrade", "Sonarr_IsUpgrade")
    ) {
      return undefined;
    }

    const title = value(
      environment,
      "sonarr_series_title",
      "Sonarr_Series_Title",
    );
    const season = value(
      environment,
      "sonarr_episodefile_seasonnumber",
      "Sonarr_EpisodeFile_SeasonNumber",
    );
    const episodes = value(
      environment,
      "sonarr_episodefile_episodenumbers",
      "Sonarr_EpisodeFile_EpisodeNumbers",
    );
    if (!title || !season || !episodes) {
      throw new Error(
        "missing Sonarr series title, season number, or episode numbers",
      );
    }
    return `📺 New TV: ${stripTrailingYear(title)} — ${
      episodeLabel(season, episodes)
    }`;
  }
}

async function send(message: string): Promise<void> {
  const endpoint = Deno.env.get("MEDIA_IMPORT_NOTIFICATION_ENDPOINT");
  if (!endpoint) throw new Error("missing notification-gateway endpoint");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: "kittypurr", message }),
  });
  if (!response.ok) {
    throw new Error(`notification gateway returned HTTP ${response.status}`);
  }
}

if (import.meta.main) {
  const names = [
    "radarr_eventtype",
    "radarr_isupgrade",
    "radarr_movie_title",
    "sonarr_eventtype",
    "sonarr_isupgrade",
    "sonarr_series_title",
    "sonarr_episodefile_seasonnumber",
    "sonarr_episodefile_episodenumbers",
    "Radarr_EventType",
    "Radarr_IsUpgrade",
    "Radarr_Movie_Title",
    "Sonarr_EventType",
    "Sonarr_IsUpgrade",
    "Sonarr_Series_Title",
    "Sonarr_EpisodeFile_SeasonNumber",
    "Sonarr_EpisodeFile_EpisodeNumbers",
  ];
  const environment = Object.fromEntries(
    names.map((name) => [name, Deno.env.get(name)]),
  );
  const message = notificationMessage(environment);
  if (message) await send(message);
}
