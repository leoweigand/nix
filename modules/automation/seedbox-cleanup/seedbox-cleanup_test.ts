import assert from "node:assert/strict";
import { join } from "node:path";
import {
  Hold,
  importProof,
  safePath,
  torrentGate,
  trackerAccount,
  trackerClearance,
  trackerId,
} from "./seedbox-cleanup.ts";

const completedPath = "/seedbox/completed/deluge";
const day = 86_400;

function torrent() {
  return {
    label: "sonarr",
    private: true,
    state: "Seeding",
    is_finished: true,
    progress: 100,
    save_path: `${completedPath}/sonarr`,
    seeding_time: 7 * day,
    files: [{ path: "Season/one.mkv", size: 4 }, {
      path: "Season/two.mkv",
      size: 4,
    }],
    file_progress: [1, 1],
    file_priorities: [1, 1],
    trackers: [{ url: "https://tracker.torrentleech.org/example/announce" }],
  };
}

function table(
  ratio = "0.4",
  seedTime = "6 days 2 hours",
  hnr = "No",
  torrentId = "123",
) {
  const headers = [
    "Name",
    "Size",
    "Sna",
    "Dld",
    "Uld",
    "Rto",
    "Ann",
    "Co",
    "Act.",
    "S.T.",
    "HnR",
    "Cl.",
  ];
  const cells = [
    `<a href="/torrent/${torrentId}">Example</a>`,
    "8",
    "1",
    "8",
    "4",
    ratio,
    "100",
    "Yes",
    "Yes",
    seedTime,
    hnr,
    "Deluge",
  ];
  return `<table id="profile-snatchListTable"><tr>${
    headers.map((header) => `<th>${header}</th>`).join("")
  }</tr><tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr></table>`;
}

Deno.test("seven active days, not six or a high ratio, are required", () => {
  torrentGate(torrent(), 6, completedPath);
  const partial = { ...torrent(), seeding_time: 7 * day - 1, ratio: 100 };
  assert.throws(() => torrentGate(partial, 6, completedPath), Hold);
});

Deno.test("partial, paused, unknown tracker, and wrong-path torrents are retained", () => {
  for (
    const delta of [
      { file_priorities: [1, 0] },
      { file_progress: [1, 0.9] },
      { state: "Paused" },
      { private: false },
      { label: "manual" },
      { save_path: "/other" },
      { trackers: [{ url: "https://evil.example/announce" }] },
    ]
  ) {
    assert.throws(
      () => torrentGate({ ...torrent(), ...delta }, 6, completedPath),
      Hold,
    );
  }
});

Deno.test("tracker clearance requires known time or ratio evidence", () => {
  trackerClearance(table(), "123", 6);
  trackerClearance(table("1.1", "0 days"), "123", 6);
  for (
    const page of [
      table("0.4", "5 days"),
      table("0.4", "999999"),
      table("0.4", "6 days", "Yes"),
      table("0.4", "6 days", ""),
      table("0.4", "6 days", "No", "456"),
      table().replace("Rto", "Changed"),
    ]
  ) {
    assert.throws(() => trackerClearance(page, "123", 6), Hold);
  }
});

Deno.test("tracker login and account class are required", () => {
  const page =
    '<a href="/user/account/logout">Logout</a><td>Class</td><td>Extreme User</td><span class="profile-ratio-details">52.873</span>';
  assert.deepEqual(trackerAccount(page), ["Extreme User", 52.873]);
  for (
    const bad of [
      page.replace("Extreme User", "Unknown"),
      page.replace("52.873", "NaN"),
      "login",
    ]
  ) {
    assert.throws(() => trackerAccount(bad));
  }
});

Deno.test("grab receipt requires the exact tracker and one torrent ID", () => {
  const event = {
    eventType: "grabbed",
    data: { nzbInfoUrl: "https://www.torrentleech.org/torrent/123" },
  };
  assert.equal(trackerId([event]), "123");
  assert.throws(() => trackerId([]), Hold);
  assert.throws(
    () =>
      trackerId([event, {
        ...event,
        data: { nzbInfoUrl: "https://www.torrentleech.org/torrent/456" },
      }]),
    Hold,
  );
});

Deno.test("every media file must be imported with matching bytes", async () => {
  const root = await Deno.makeTempDir();
  try {
    const inbox = join(root, "sources/seedbox/deluge/sonarr/Season");
    const library = join(root, "library/tv/Series");
    await Deno.mkdir(inbox, { recursive: true });
    await Deno.mkdir(library, { recursive: true });
    const history: Array<
      { eventType: string; data: { droppedPath: string; importedPath: string } }
    > = [];
    for (const name of ["one.mkv", "two.mkv"]) {
      await Deno.writeTextFile(join(inbox, name), "data");
      await Deno.writeTextFile(join(library, name), "data");
      history.push({
        eventType: "downloadFolderImported",
        data: {
          droppedPath: `/media/sources/seedbox/deluge/sonarr/Season/${name}`,
          importedPath: `/media/library/tv/Series/${name}`,
        },
      });
    }
    assert.equal(await importProof(torrent(), history, "sonarr", root), 2);
    await assert.rejects(
      () => importProof(torrent(), history.slice(0, 1), "sonarr", root),
      Hold,
    );
    await Deno.writeTextFile(join(library, "two.mkv"), "evil");
    await assert.rejects(
      () => importProof(torrent(), history, "sonarr", root),
      Hold,
    );
    await Deno.remove(join(library, "two.mkv"));
    await assert.rejects(
      () => importProof(torrent(), history, "sonarr", root),
      Hold,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("archives, traversal, absolute paths, and symlinks are retained", async () => {
  const root = await Deno.makeTempDir();
  try {
    const inbox = join(root, "sources/seedbox/deluge/sonarr");
    await Deno.mkdir(inbox, { recursive: true });
    await Deno.writeTextFile(join(inbox, "movie.rar"), "data");
    await assert.rejects(
      () =>
        importProof(
          { ...torrent(), files: [{ path: "movie.rar", size: 4 }] },
          [],
          "sonarr",
          root,
        ),
      Hold,
    );
    await assert.rejects(() => safePath(inbox, "../escape.mkv"), Hold);
    await assert.rejects(() => safePath(inbox, "/absolute.mkv"), Hold);
    await Deno.symlink(root, join(inbox, "linked"));
    await assert.rejects(() => safePath(inbox, "linked/file.mkv"), Hold);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
