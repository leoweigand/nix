import { restrictedFetch } from "../../runtime/network.ts";
import { createReadStream, readFileSync, type Stats } from "node:fs";
import {
  lstat as nodeLstat,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { CookieJar, wrapFetch } from "@jd1378/another-cookiejar";
import { isElement, isText, parse } from "@std/xml";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, join, posix, relative, resolve } from "node:path";

const automationFetch = restrictedFetch([
  "http://127.0.0.1:7878",
  "http://127.0.0.1:8989",
  "https://tiny.seedhost.eu",
  "https://www.torrentleech.org",
]);

/** Conservative Deluge cleanup. Missing evidence always retains the torrent.
 *
 * Only torrents grabbed by Arr and fully copied into its library are managed.
 * Tracker HTML is a read-only input, never a source of commands or URLs to follow.
 */

const day = 86_400;
const appdata = "/mnt/fast/appdata";
const media = "/mnt/media";
const tracker = "https://www.torrentleech.org";
const minimumDays: Record<string, number> = {
  Registered: 10,
  "Power User": 8,
  "Super User": 7,
  "Extreme User": 6,
  "TL God": 4,
};
const video = new Set([
  ".mkv",
  ".mp4",
  ".avi",
  ".m4v",
  ".ts",
  ".m2ts",
  ".mpg",
  ".mpeg",
  ".wmv",
]);
const sidecars = new Set([
  ".nfo",
  ".txt",
  ".jpg",
  ".jpeg",
  ".png",
  ".srt",
  ".sub",
  ".idx",
  ".ass",
  ".ssa",
  ".sfv",
  ".srr", // ReScene archive metadata; the extracted video is checked separately.
]);

type Json = Record<string, any>;
export type CleanupTrigger = "ratio" | "seeding-time" | "either";

interface SeedboxConfig {
  completedPath: string;
  delugeUrl: string;
}

export class Hold extends Error {}

function requireEvidence(
  condition: unknown,
  reason: string,
): asserts condition {
  if (!condition) throw new Hold(reason);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  requireEvidence(value, `${name} must be set`);
  return value;
}

export function loadSeedboxConfig(): SeedboxConfig {
  const completedPath = requiredEnvironment("SEEDBOX_COMPLETED_PATH").replace(
    /\/+$/,
    "",
  );
  requireEvidence(
    posix.isAbsolute(completedPath),
    "SEEDBOX_COMPLETED_PATH must be absolute",
  );
  const delugeUrl = requiredEnvironment("SEEDBOX_DELUGE_URL");
  requireEvidence(
    new URL(delugeUrl).protocol === "https:",
    "SEEDBOX_DELUGE_URL must use HTTPS",
  );
  return { completedPath, delugeUrl };
}

function plain(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(
      /&(?:amp|lt|gt|quot|#39);/g,
      (entity) =>
        ({
          "&amp;": "&",
          "&lt;": "<",
          "&gt;": ">",
          "&quot;": '"',
          "&#39;": "'",
        })[entity]!,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function number(value: string): number {
  const result = Number(plain(value));
  requireEvidence(
    Number.isFinite(result) && result >= 0,
    "invalid numeric evidence",
  );
  return result;
}

function duration(value: string): number {
  const text = plain(value).toLowerCase();
  const units: Record<string, number> = { d: day, h: 3600, m: 60, s: 1 };
  const pattern =
    /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/g;
  const parts = [...text.matchAll(pattern)];
  requireEvidence(
    parts.length > 0 &&
      text.replace(pattern, "").replaceAll(",", "").trim() === "",
    "unknown tracker time format",
  );
  return parts.reduce(
    (total, match) => total + Number(match[1]) * units[match[2][0]],
    0,
  );
}

export function trackerAccount(page: string): [string, number] {
  requireEvidence(
    page.includes('href="/user/account/logout"'),
    "tracker session expired",
  );
  const accountClass = page.match(/<td>Class<\/td>\s*<td>([^<]+)<\/td>/);
  const ratio = page.match(/class="[^"]*profile-ratio-details[^"]*">([^<]+)</);
  requireEvidence(accountClass && ratio, "tracker profile format changed");
  const name = plain(accountClass[1]);
  requireEvidence(name in minimumDays, "tracker class requires policy review");
  return [name, number(ratio[1])];
}

export function trackerClearance(
  page: string,
  torrentId: string,
  minimum: number,
  trigger?: CleanupTrigger,
): void {
  const table = page.match(
    /<table\b[^>]*id="profile-snatchListTable"[^>]*>(.*?)<\/table>/s,
  );
  requireEvidence(table, "tracker snatchlist format changed");
  const headers = [...table[1].matchAll(/<th\b[^>]*>(.*?)<\/th>/gs)].map(
    (match) => plain(match[1]),
  );
  const expected = [
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
  ];
  requireEvidence(
    headers.length >= 11 &&
      headers.slice(0, 11).every((header, index) => header === expected[index]),
    "tracker columns changed",
  );
  const found: string[][] = [];
  for (const row of table[1].matchAll(/<tr\b[^>]*>(.*?)<\/tr>/gs)) {
    const ids = [
      ...row[1].matchAll(
        /href=["'](?:https:\/\/www\.torrentleech\.org)?\/torrent\/(\d+)["']/g,
      ),
    ].map((match) => match[1]);
    if (ids.includes(String(torrentId))) {
      found.push(
        [...row[1].matchAll(/<td\b[^>]*>(.*?)<\/td>/gs)].map(
          (match) => match[1],
        ),
      );
    }
  }
  requireEvidence(
    found.length === 1 && found[0].length >= 11,
    "no unique tracker snatch record",
  );
  const cells = found[0];
  requireEvidence(
    ["no", "0", "false", "-"].includes(plain(cells[10]).toLowerCase()),
    "tracker HnR status unclear or active",
  );
  let seeded = 0;
  try {
    seeded = duration(cells[9]);
  } catch (error) {
    if (!(error instanceof Hold)) throw error;
  }
  requireEvidence(
    trigger === "ratio"
      ? number(cells[5]) >= 1
      : trigger === "seeding-time"
        ? seeded >= minimum * day
        : seeded >= minimum * day || number(cells[5]) >= 1,
    "tracker obligation not yet satisfied",
  );
}

async function lstat(path: string): Promise<Stats | undefined> {
  try {
    return await nodeLstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function safePath(root: string, input: string): Promise<string> {
  const relativePath = posix.normalize(input);
  requireEvidence(
    !posix.isAbsolute(input) &&
      relativePath !== "." &&
      !relativePath.startsWith("../") &&
      !relativePath.includes("/../"),
    "unsafe payload path",
  );
  const path = join(root, ...relativePath.split("/"));
  requireEvidence(
    !isAbsolute(relative(root, resolve(path))) &&
      !relative(root, resolve(path)).startsWith(".."),
    "path outside approved root",
  );
  for (
    let current = path;
    current.startsWith(root);
    current = dirname(current)
  ) {
    const info = await lstat(current);
    requireEvidence(!info?.isSymbolicLink(), "symlink in payload/library path");
    if (current === root) break;
  }
  return path;
}

async function digest(path: string): Promise<string> {
  const file = createReadStream(path);
  const hash = createHash("sha256");
  // Async iteration closes the stream, including when hashing fails.
  for await (const chunk of file) hash.update(chunk);
  return hash.digest("hex");
}

function statFingerprint(info: Stats): string {
  return [
    info.ino,
    info.size,
    info.mtime?.getTime(),
    info.ctime?.getTime(),
  ].join(":");
}

async function stableCopy(
  source: string,
  target: string,
  expectedSize: number,
  verifiedCopies?: Record<string, string>,
): Promise<void> {
  const [beforeSource, beforeTarget] = await Promise.all([
    lstat(source),
    lstat(target),
  ]);
  requireEvidence(
    beforeSource !== undefined &&
      beforeTarget !== undefined &&
      beforeSource.isFile() &&
      beforeTarget.isFile(),
    "imported file or mirror missing",
  );
  requireEvidence(
    beforeSource.size === expectedSize && beforeTarget.size === expectedSize,
    "file size differs from torrent",
  );
  const cacheKey = JSON.stringify([source, target, expectedSize]);
  const fingerprint = `${statFingerprint(beforeSource)}|${statFingerprint(
    beforeTarget,
  )}`;
  if (verifiedCopies?.[cacheKey] === fingerprint) return;
  requireEvidence(
    (await digest(source)) === (await digest(target)),
    "library bytes differ from download",
  );
  const [afterSource, afterTarget] = await Promise.all([
    stat(source),
    stat(target),
  ]);
  requireEvidence(
    statFingerprint(beforeSource) === statFingerprint(afterSource) &&
      statFingerprint(beforeTarget) === statFingerprint(afterTarget),
    "file changed during verification",
  );
  if (verifiedCopies) verifiedCopies[cacheKey] = fingerprint;
}

export async function importProof(
  torrent: Json,
  history: Json[],
  app: string,
  mediaRoot = media,
  verifiedCopies?: Record<string, string>,
): Promise<number> {
  const inbox = join(mediaRoot, "sources/seedbox/deluge", app);
  const library = join(mediaRoot, "library", app === "sonarr" ? "tv" : "films");
  const imports = new Map<string, Set<string | undefined>>();
  for (const event of history) {
    if (event.eventType === "downloadFolderImported") {
      const dropped = event.data?.droppedPath;
      if (typeof dropped === "string") {
        const entries = imports.get(dropped) ?? new Set<string | undefined>();
        entries.add(event.data.importedPath);
        imports.set(dropped, entries);
      }
    }
  }
  let count = 0;
  for (const entry of torrent.files as Json[]) {
    const parts: string[] = entry.path.split("/");
    const path = await safePath(inbox, entry.path);
    const info = await lstat(path);
    requireEvidence(
      info?.isFile && info.size === entry.size,
      "torrent payload not fully mirrored",
    );
    const filename = parts.at(-1)!;
    const suffix = filename.includes(".")
      ? `.${filename.split(".").at(-1)!.toLowerCase()}`
      : "";
    const stem = filename.replace(/\.[^.]+$/, "");
    const sample =
      parts.slice(0, -1).some((part) => part.toLowerCase() === "sample") ||
      /(^|[._ -])sample([._ -]|$)/i.test(stem);
    if (video.has(suffix) && !sample) {
      const candidates =
        imports.get(`/media/sources/seedbox/deluge/${app}/${entry.path}`) ??
        new Set();
      requireEvidence(
        candidates.size === 1 && !candidates.has(undefined),
        "missing or ambiguous media import receipt",
      );
      const imported = [...candidates][0]!;
      const prefix = `/media/library/${app === "sonarr" ? "tv" : "films"}/`;
      requireEvidence(
        imported.startsWith(prefix),
        "import receipt outside library",
      );
      const target = await safePath(library, imported.slice(prefix.length));
      await stableCopy(path, target, entry.size, verifiedCopies);
      count++;
    } else {
      requireEvidence(
        (sample && video.has(suffix)) || sidecars.has(suffix),
        "unaccounted payload type (archive/disc/extra)",
      );
    }
  }
  requireEvidence(count > 0, "no verified imported media");
  return count;
}

export function torrentGate(
  torrent: Json,
  minimum: number,
  completedPath: string,
): CleanupTrigger {
  requireEvidence(
    ["sonarr", "radarr"].includes(torrent.label),
    "unmanaged label",
  );
  requireEvidence(torrent.private === true, "not a private tracker torrent");
  requireEvidence(
    torrent.state === "Seeding" &&
      torrent.is_finished === true &&
      torrent.progress === 100,
    "not fully seeding",
  );
  requireEvidence(
    torrent.save_path?.replace(/\/+$/, "") ===
      `${completedPath}/${torrent.label}`,
    "outside managed completed directory",
  );
  requireEvidence(
    Array.isArray(torrent.files) && torrent.files.length > 0,
    "no payload manifest",
  );
  requireEvidence(
    Array.isArray(torrent.file_progress) &&
      torrent.file_progress.length === torrent.files.length &&
      torrent.file_progress.every((value: unknown) => value === 1),
    "partial torrent",
  );
  requireEvidence(
    Array.isArray(torrent.file_priorities) &&
      torrent.file_priorities.length === torrent.files.length &&
      torrent.file_priorities.every(
        (value: unknown) => typeof value === "number" && value > 0,
      ),
    "selective download",
  );
  const hosts = (torrent.trackers as Json[] | undefined)?.map(
    (entry) => new URL(entry.url).hostname,
  );
  requireEvidence(
    hosts?.length &&
      hosts.every((host) =>
        [
          "tracker.torrentleech.org",
          "tracker.torrentleech.cc",
          "tracker.tleechreload.org",
        ].includes(host),
      ),
    "unknown or mixed tracker policy",
  );
  const ratioReached = Number.isFinite(torrent.ratio) && torrent.ratio >= 1;
  const timeReached =
    Number.isFinite(torrent.seeding_time) &&
    torrent.seeding_time >= (minimum + 1) * day;
  requireEvidence(
    ratioReached || timeReached,
    "neither minimum ratio nor seeding time plus margin reached",
  );
  return ratioReached && timeReached
    ? "either"
    : ratioReached
      ? "ratio"
      : "seeding-time";
}

export function trackerId(history: Json[]): string {
  const ids = new Set<string>();
  for (const event of history) {
    if (event.eventType !== "grabbed") continue;
    const url = new URL(event.data?.nzbInfoUrl ?? "https://invalid.example");
    const match = url.pathname.match(/^\/torrent\/(\d+)$/);
    if (url.hostname === "www.torrentleech.org" && match) ids.add(match[1]);
  }
  requireEvidence(ids.size === 1, "missing unique TorrentLeech grab receipt");
  return [...ids][0];
}

async function jsonRequest(url: string, init: RequestInit): Promise<Json> {
  const response = await automationFetch(url, {
    ...init,
    signal: AbortSignal.timeout(30_000),
  });
  requireEvidence(response.ok, `HTTP request failed: ${new URL(url).hostname}`);
  const value: unknown = await response.json();
  requireEvidence(
    typeof value === "object" && value !== null,
    "invalid API JSON response",
  );
  return value as Json;
}

function textContent(
  element: ReturnType<typeof parse>["root"],
  name: string,
): string | undefined {
  const child = element.children.find(
    (node) => isElement(node) && node.name.local === name,
  );
  if (!child || !isElement(child)) return undefined;
  const text = child.children.find(isText);
  return text?.text;
}

class Arr {
  readonly base: string;
  readonly key: string;

  constructor(app: string) {
    this.base = `http://127.0.0.1:${
      app === "sonarr" ? "8989" : "7878"
    }/api/v3/`;
    const document = parse(
      readFileSync(join(appdata, app, "config.xml"), "utf8"),
    );
    this.key = textContent(document.root, "ApiKey") ?? "";
    requireEvidence(this.key, "Arr API key missing");
  }

  async get(path: string): Promise<Json> {
    return await jsonRequest(new URL(path, this.base).toString(), {
      headers: { "x-api-key": this.key },
    });
  }

  async history(infohash: string): Promise<Json[]> {
    const records: Json[] = [];
    for (let page = 1; page <= 100; page++) {
      const query = new URLSearchParams({
        downloadId: infohash.toUpperCase(),
        pageSize: "1000",
        page: String(page),
      });
      const data = await this.get(`history?${query}`);
      records.push(
        ...(data.records as Json[]).filter(
          (record) =>
            record.downloadId?.toLowerCase() === infohash.toLowerCase(),
        ),
      );
      if (page * 1000 >= data.totalRecords) return records;
    }
    throw new Hold("history exceeds safe pagination limit");
  }
}

class Deluge {
  private readonly fetch: typeof globalThis.fetch;
  private readonly url: string;
  private readonly password: string;

  constructor(url: string, password: string) {
    this.url = url;
    this.password = password;
    this.fetch = wrapFetch({
      cookieJar: new CookieJar(),
      fetch: automationFetch,
    });
  }

  async connect(): Promise<void> {
    requireEvidence(
      (await this.call("auth.login", [this.password])) === true,
      "Deluge authentication failed",
    );
    if (!(await this.call("web.connected", []))) {
      const hosts = (await this.call("web.get_hosts", [])) as unknown[];
      requireEvidence(hosts.length === 1, "ambiguous provider daemon");
      await this.call("web.connect", [(hosts[0] as unknown[])[0]]);
    }
    requireEvidence(
      await this.call("web.connected", []),
      "Deluge daemon disconnected",
    );
  }

  async call(method: string, params: unknown[]): Promise<any> {
    const response = await this.fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, method, params }),
      signal: AbortSignal.timeout(30_000),
    });
    requireEvidence(response.ok, "Deluge HTTP request failed");
    const result = (await response.json()) as Json;
    requireEvidence(!result.error, `Deluge RPC failed: ${method}`);
    return result.result;
  }

  async torrents(): Promise<Record<string, Json>> {
    const fields = [
      "name",
      "label",
      "private",
      "save_path",
      "files",
      "file_progress",
      "file_priorities",
      "is_finished",
      "progress",
      "state",
      "seeding_time",
      "ratio",
      "trackers",
    ];
    return await this.call("core.get_torrents_status", [{}, fields]);
  }
}

class Tracker {
  readonly username: string;
  readonly headers: Headers;
  private lastRequest = 0;

  constructor() {
    const database = new DatabaseSync(
      join(appdata, "prowlarr", "prowlarr.db"),
      { readOnly: true },
    );
    const rows = database
      .prepare(
        "SELECT s.Cookies, i.Settings FROM IndexerStatus s JOIN Indexers i ON i.Id=s.ProviderId WHERE i.Name='TorrentLeech'",
      )
      .all() as Json[];
    database.close();
    requireEvidence(rows.length === 1, "missing tracker session");
    const cookies = JSON.parse(rows[0].Cookies);
    const settings = JSON.parse(rows[0].Settings);
    this.username = settings.extraFieldData?.username;
    requireEvidence(
      typeof this.username === "string" &&
        /^[A-Za-z0-9_-]+$/.test(this.username),
      "unsupported tracker username",
    );
    requireEvidence(
      typeof cookies === "object" &&
        cookies !== null &&
        Object.keys(cookies).length > 0,
      "missing tracker cookies",
    );
    this.headers = new Headers({
      cookie: Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
      "user-agent": "Mozilla/5.0",
    });
  }

  async page(suffix: string): Promise<string> {
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, 4200 - (performance.now() - this.lastRequest)),
      ),
    );
    const response = await automationFetch(
      `${tracker}/profile/${this.username}/${suffix}`,
      {
        headers: this.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      },
    );
    requireEvidence(
      response.status < 300 || response.status >= 400,
      "tracker redirected; refresh session in Prowlarr",
    );
    requireEvidence(response.ok, "tracker HTTP request failed");
    const page = await response.text();
    this.lastRequest = performance.now();
    requireEvidence(
      page.includes('href="/user/account/logout"'),
      "tracker session expired",
    );
    return page;
  }
}

function filePaths(torrent: Json): Set<string> {
  return new Set(
    (torrent.files as Json[]).map((entry) =>
      posix.join(torrent.save_path, entry.path),
    ),
  );
}

async function writeJson(path: string, data: unknown): Promise<void> {
  const temporary = path.replace(/\.json$/, ".tmp");
  await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
  await rename(temporary, path);
}

// Checks run every fifteen minutes; a gap of an hour resets the proof window.
export function eligibility(
  previous: Json | undefined,
  manifest: string,
  now: number,
): Json {
  const continuous =
    previous?.manifest === manifest &&
    Number.isFinite(previous.since) &&
    Number.isFinite(previous.lastSeen) &&
    previous.since <= previous.lastSeen &&
    previous.lastSeen <= now &&
    now - previous.lastSeen < 3600;
  return { since: continuous ? previous.since : now, lastSeen: now, manifest };
}

export async function run(
  apply: boolean,
  stateDirectory: string,
  passwordFile: string,
): Promise<void> {
  const seedbox = loadSeedboxConfig();
  const arrs = { sonarr: new Arr("sonarr"), radarr: new Arr("radarr") };
  const clients = ((await arrs.sonarr.get("downloadclient")) as Json[]).filter(
    (client) => client.implementation === "Deluge" && client.enable,
  );
  requireEvidence(clients.length === 1, "expected one enabled Deluge client");
  const fields = Object.fromEntries(
    (clients[0].fields as Json[]).map((field) => [field.name, field.value]),
  );
  requireEvidence(
    fields.host === "tiny.seedhost.eu",
    "unexpected Deluge endpoint",
  );
  const deluge = new Deluge(
    seedbox.delugeUrl,
    (await readFile(passwordFile, "utf8")).trim(),
  );
  await deluge.connect();
  const trackerClient = new Tracker();
  const [accountClass, ratio] = trackerAccount(
    await trackerClient.page("view"),
  );
  requireEvidence(
    ratio >= 1,
    "overall ratio below conservative 1.0 floor; retain seeds",
  );
  const minimum = minimumDays[accountClass];
  const torrents = await deluge.torrents();
  const report: Json = {
    checkedAt: Math.floor(Date.now() / 1000),
    apply,
    complete: false,
    accountClass,
    overallRatio: ratio,
    torrents: {},
  };
  await mkdir(stateDirectory, { recursive: true });
  const statePath = join(stateDirectory, "eligible.json");
  let previous: Json = {};
  try {
    previous = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const copyCachePath = join(stateDirectory, "verified-copies.json");
  let verifiedCopies: Record<string, string> = {};
  try {
    verifiedCopies = JSON.parse(await readFile(copyCachePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const eligible: Json = {};
  let snatches: string | undefined;
  for (const [infohash, torrent] of Object.entries(torrents)) {
    try {
      const trigger = torrentGate(torrent, minimum, seedbox.completedPath);
      const files = filePaths(torrent);
      for (const [otherHash, other] of Object.entries(torrents)) {
        if (otherHash !== infohash) {
          requireEvidence(
            [...files].every((path) => !filePaths(other).has(path)),
            "payload shared with another torrent",
          );
        }
      }
      const history =
        await arrs[torrent.label as "sonarr" | "radarr"].history(infohash);
      const torrentIdentifier = trackerId(history);
      snatches ??= await trackerClient.page("snatchlist");
      trackerClearance(snatches, torrentIdentifier, minimum, trigger);
      // Cache immutable copies between checks; deletion below always rehashes.
      const count = await importProof(
        torrent,
        history,
        torrent.label,
        media,
        verifiedCopies,
      );
      const manifest = createHash("sha256")
        .update(JSON.stringify(torrent.files))
        .digest("hex");
      const now = Date.now() / 1000;
      eligible[infohash] = eligibility(previous[infohash], manifest, now);
      requireEvidence(
        now - eligible[infohash].since >= 3600,
        "eligibility must remain proven for one hour",
      );
      if (apply) {
        const fresh = await deluge.torrents();
        requireEvidence(infohash in fresh, "torrent disappeared");
        const freshTrigger = torrentGate(
          fresh[infohash],
          minimum,
          seedbox.completedPath,
        );
        requireEvidence(
          JSON.stringify(fresh[infohash].files) ===
            JSON.stringify(torrent.files),
          "manifest changed",
        );
        for (const [otherHash, other] of Object.entries(fresh)) {
          if (otherHash !== infohash) {
            requireEvidence(
              [...files].every((path) => !filePaths(other).has(path)),
              "new overlapping torrent",
            );
          }
        }
        const [latestClass, latestRatio] = trackerAccount(
          await trackerClient.page("view"),
        );
        requireEvidence(
          latestClass === accountClass && latestRatio >= 1,
          "account policy changed",
        );
        trackerClearance(
          await trackerClient.page("snatchlist"),
          torrentIdentifier,
          minimum,
          freshTrigger,
        );
        await importProof(
          fresh[infohash],
          await arrs[fresh[infohash].label as "sonarr" | "radarr"].history(
            infohash,
          ),
          fresh[infohash].label,
        );
        requireEvidence(
          (await deluge.call("core.remove_torrent", [infohash, true])) === true,
          "Deluge did not confirm removal",
        );
        delete eligible[infohash];
      }
      report.torrents[infohash] = {
        status: apply ? "removed" : "eligible-dry-run",
        verifiedMediaFiles: count,
        trigger,
      };
    } catch (error) {
      report.torrents[infohash] = {
        status: "retained",
        reason:
          error instanceof Hold
            ? error.message
            : error instanceof Error
              ? error.name
              : "unknown error",
      };
    }
    // Large batches can exceed the service deadline; keep each completed check.
    await writeJson(copyCachePath, verifiedCopies);
    await writeJson(statePath, eligible);
    await writeJson(join(stateDirectory, "report.json"), report);
  }
  report.complete = true;
  await writeJson(join(stateDirectory, "report.json"), report);
  console.log(JSON.stringify(report));
}

function argumentsFrom(args: string[]): {
  apply: boolean;
  stateDirectory: string;
  passwordFile: string;
} {
  let apply = false;
  let stateDirectory = "/var/lib/seedbox-cleanup";
  let passwordFile: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--apply") apply = true;
    else if (args[index] === "--state-dir") {
      stateDirectory = args[++index] ?? "";
    } else if (args[index] === "--deluge-password-file") {
      passwordFile = args[++index];
    } else throw new Hold("invalid command-line argument");
  }
  requireEvidence(passwordFile, "--deluge-password-file is required");
  return { apply, stateDirectory, passwordFile };
}

if (import.meta.main) {
  const args = argumentsFrom(process.argv.slice(2));
  try {
    await run(args.apply, args.stateDirectory, args.passwordFile);
  } catch (error) {
    const failure = {
      checkedAt: Math.floor(Date.now() / 1000),
      status: "cleanup-interrupted",
      reason:
        error instanceof Hold
          ? error.message
          : error instanceof Error
            ? error.name
            : "unknown error",
    };
    await mkdir(args.stateDirectory, { recursive: true });
    await writeJson(join(args.stateDirectory, "report.json"), failure);
    await writeJson(join(args.stateDirectory, "eligible.json"), {});
    console.log(JSON.stringify(failure));
    process.exit(1);
  }
}
