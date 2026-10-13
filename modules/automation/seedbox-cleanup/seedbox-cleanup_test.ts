import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  eligibility,
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
    ratio: 0.4,
    files: [
      { path: "Season/one.mkv", size: 4 },
      {
        path: "Season/two.mkv",
        size: 4,
      },
    ],
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
  return `<table id="profile-snatchListTable"><tr>${headers
    .map((header) => `<th>${header}</th>`)
    .join(
      "",
    )}</tr><tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr></table>`;
}

test("time and ratio are independent cleanup triggers", () => {
  assert.equal(torrentGate(torrent(), 6, completedPath), "seeding-time");
  assert.equal(
    torrentGate({ ...torrent(), seeding_time: 0, ratio: 1 }, 6, completedPath),
    "ratio",
  );
  assert.equal(
    torrentGate({ ...torrent(), ratio: 1 }, 6, completedPath),
    "either",
  );
  for (const ratio of [0.999, undefined, NaN, Infinity]) {
    assert.throws(
      () =>
        torrentGate(
          { ...torrent(), seeding_time: 7 * day - 1, ratio },
          6,
          completedPath,
        ),
      Hold,
    );
  }
  for (const minimum of [4, 6, 7, 8, 10]) {
    assert.equal(
      torrentGate(
        { ...torrent(), seeding_time: (minimum + 1) * day },
        minimum,
        completedPath,
      ),
      "seeding-time",
    );
    assert.throws(
      () =>
        torrentGate(
          { ...torrent(), seeding_time: (minimum + 1) * day - 1 },
          minimum,
          completedPath,
        ),
      Hold,
    );
  }
});

test("TorrentLeech's alternate announce host is accepted without permitting mixed trackers", () => {
  torrentGate(
    {
      ...torrent(),
      trackers: [
        ...torrent().trackers,
        {
          url: "https://tracker.tleechreload.org/example/announce",
        },
      ],
    },
    6,
    completedPath,
  );
  assert.throws(
    () =>
      torrentGate(
        {
          ...torrent(),
          ratio: 100,
          trackers: [
            ...torrent().trackers,
            {
              url: "https://evil.example/announce",
            },
          ],
        },
        6,
        completedPath,
      ),
    Hold,
  );
});

test("quarter-hour checks accumulate an hour of unchanged evidence", () => {
  let proof = eligibility(undefined, "manifest", 10000);
  for (const now of [10900, 11800, 12700, 13600]) {
    proof = eligibility(proof, "manifest", now);
    assert.equal(proof.since, 10000);
  }
  assert.equal(proof.lastSeen - proof.since, 3600);
  assert.equal(eligibility(proof, "changed", 14500).since, 14500);
  assert.equal(eligibility(proof, "manifest", 17200).since, 17200);
  assert.equal(eligibility(proof, "manifest", 10000).since, 10000);
});

test("partial, paused, unknown tracker, and wrong-path torrents are retained", () => {
  for (const delta of [
    { file_priorities: [1, 0] },
    { file_progress: [1, 0.9] },
    { state: "Paused" },
    { private: false },
    { label: "manual" },
    { save_path: "/other" },
    { trackers: [{ url: "https://evil.example/announce" }] },
  ]) {
    assert.throws(
      () =>
        torrentGate({ ...torrent(), ratio: 100, ...delta }, 6, completedPath),
      Hold,
    );
  }
});

test("tracker clearance requires known time or ratio evidence", () => {
  trackerClearance(table(), "123", 6);
  trackerClearance(table("1.1", "0 days"), "123", 6);
  trackerClearance(table("1", "0 days"), "123", 6, "ratio");
  trackerClearance(table("0.4", "6 days"), "123", 6, "either");
  trackerClearance(table("1", "0 days"), "123", 6, "either");
  trackerClearance(
    table("0.4", "6 days, 21 hrs, 18 secs"),
    "123",
    6,
    "seeding-time",
  );
  assert.throws(
    () => trackerClearance(table("0.4", "6 days"), "123", 6, "ratio"),
    Hold,
  );
  assert.throws(
    () => trackerClearance(table("1", "5 days"), "123", 6, "seeding-time"),
    Hold,
  );
  for (const page of [
    table("0.4", "5 days"),
    table("0.4", "999999"),
    table("0.4", "6 days", "Yes"),
    table("0.4", "6 days", ""),
    table("0.4", "6 days", "No", "456"),
    table().replace("Rto", "Changed"),
  ]) {
    assert.throws(() => trackerClearance(page, "123", 6), Hold);
  }
});

test("tracker login and account class are required", () => {
  const page =
    '<a href="/user/account/logout">Logout</a><td>Class</td><td>Extreme User</td><span class="profile-ratio-details">52.873</span>';
  assert.deepEqual(trackerAccount(page), ["Extreme User", 52.873]);
  for (const bad of [
    page.replace("Extreme User", "Unknown"),
    page.replace("52.873", "NaN"),
    "login",
  ]) {
    assert.throws(() => trackerAccount(bad));
  }
});

test("grab receipt requires the exact tracker and one torrent ID", () => {
  const event = {
    eventType: "grabbed",
    data: { nzbInfoUrl: "https://www.torrentleech.org/torrent/123" },
  };
  assert.equal(trackerId([event]), "123");
  assert.throws(() => trackerId([]), Hold);
  assert.throws(
    () =>
      trackerId([
        event,
        {
          ...event,
          data: { nzbInfoUrl: "https://www.torrentleech.org/torrent/456" },
        },
      ]),
    Hold,
  );
});

test("every media file must be imported with matching bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedbox-cleanup-"));
  try {
    const inbox = join(root, "sources/seedbox/deluge/sonarr/Season");
    const library = join(root, "library/tv/Series");
    await mkdir(inbox, { recursive: true });
    await mkdir(library, { recursive: true });
    const history: Array<{
      eventType: string;
      data: { droppedPath: string; importedPath: string };
    }> = [];
    for (const name of ["one.mkv", "two.mkv"]) {
      await writeFile(join(inbox, name), "data");
      await writeFile(join(library, name), "data");
      history.push({
        eventType: "downloadFolderImported",
        data: {
          droppedPath: `/media/sources/seedbox/deluge/sonarr/Season/${name}`,
          importedPath: `/media/library/tv/Series/${name}`,
        },
      });
    }
    await writeFile(join(inbox, "release.srr"), "meta");
    const withMetadata = {
      ...torrent(),
      files: [...torrent().files, { path: "Season/release.srr", size: 4 }],
    };
    const verifiedCopies: Record<string, string> = {};
    assert.equal(
      await importProof(withMetadata, history, "sonarr", root, verifiedCopies),
      2,
    );
    assert.equal(Object.keys(verifiedCopies).length, 2);
    assert.equal(
      await importProof(withMetadata, history, "sonarr", root, verifiedCopies),
      2,
    );
    await assert.rejects(
      () => importProof(withMetadata, history.slice(0, 1), "sonarr", root),
      Hold,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(join(library, "two.mkv"), "evil");
    await assert.rejects(
      () => importProof(withMetadata, history, "sonarr", root, verifiedCopies),
      Hold,
    );
    await assert.rejects(
      () => importProof(withMetadata, history, "sonarr", root),
      Hold,
    );
    await rm(join(library, "two.mkv"));
    await assert.rejects(
      () => importProof(withMetadata, history, "sonarr", root),
      Hold,
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

test("archives, traversal, absolute paths, and symlinks are retained", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedbox-cleanup-"));
  try {
    const inbox = join(root, "sources/seedbox/deluge/sonarr");
    await mkdir(inbox, { recursive: true });
    await writeFile(join(inbox, "movie.rar"), "data");
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
    await symlink(root, join(inbox, "linked"));
    await assert.rejects(() => safePath(inbox, "linked/file.mkv"), Hold);
  } finally {
    await rm(root, { recursive: true });
  }
});
