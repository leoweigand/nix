import { test } from "node:test";
import assert from "node:assert/strict";
import { cardMarkdown } from "./replies.ts";

test("cards retain text without artwork and only embed public catalog artwork", () => {
  assert.equal(cardMarkdown({ text: "Dune" }), "Dune");
  assert.equal(
    cardMarkdown({
      text: "Dune",
      poster: "https://image.tmdb.org/film(1).jpg",
    }),
    "![Film poster](https://image.tmdb.org/film%281%29.jpg)\nDune",
  );
  for (const poster of [
    "http://image.tmdb.org/a.jpg",
    "https://127.0.0.1/a.jpg",
    "https://image.tmdb.org@evil.example/a.jpg",
    "https://secret@image.tmdb.org/a.jpg",
    "https://image.tmdb.org:8080/a.jpg",
  ]) {
    assert.throws(() => cardMarkdown({ text: "Dune", poster }));
  }
});
