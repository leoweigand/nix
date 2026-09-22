import { notificationMessage } from "./media-import-notifications.ts";

function equal(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`expected ${expected}, got ${actual}`);
  }
}

Deno.test("formats a newly imported Radarr movie", () => {
  equal(
    notificationMessage({
      radarr_eventtype: "Download",
      radarr_movie_title: "The Apartment (1960)",
    }),
    "🎬 New movie: The Apartment",
  );
});

Deno.test("ignores Radarr test and upgrade events", () => {
  equal(notificationMessage({ radarr_eventtype: "Test" }), undefined);
  equal(
    notificationMessage({
      radarr_eventtype: "Download",
      radarr_isupgrade: "True",
    }),
    undefined,
  );
});

Deno.test("formats a Sonarr import completion", () => {
  equal(
    notificationMessage({
      sonarr_eventtype: "Download",
      sonarr_series_title: "The Bear (2022)",
      sonarr_episodefile_seasonnumber: "4",
      sonarr_episodefile_episodenumbers: "1,2",
    }),
    "📺 New TV: The Bear — S04E01, E02",
  );
});

Deno.test("accepts the environment-variable casing in Arr source", () => {
  equal(
    notificationMessage({
      Radarr_EventType: "Download",
      Radarr_Movie_Title: "Victoria",
    }),
    "🎬 New movie: Victoria",
  );
});
