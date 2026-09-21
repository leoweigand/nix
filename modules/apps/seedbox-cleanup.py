"""Conservative Deluge cleanup. Missing evidence always retains the torrent.

Only torrents grabbed by Arr and fully copied into its library are managed.
Tracker HTML is a read-only input, never a source of commands or URLs to follow.
"""

import argparse
import hashlib
import html
import http.cookiejar
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


DAY = 86400
APPDATA = Path("/mnt/fast/appdata")
MEDIA = Path("/mnt/media")
REMOTE = "/home3/cosmicwhirl/downloads/complete/deluge"
TRACKER = "https://www.torrentleech.org"
MIN_DAYS = {"Registered": 10, "Power User": 8, "Super User": 7,
            "Extreme User": 6, "TL God": 4}
VIDEO = {".mkv", ".mp4", ".avi", ".m4v", ".ts", ".m2ts", ".mpg", ".mpeg", ".wmv"}
SIDECARS = {".nfo", ".txt", ".jpg", ".jpeg", ".png", ".srt", ".sub", ".idx", ".ass", ".ssa", ".sfv"}


class Hold(Exception):
    pass


def require(condition, reason):
    if not condition:
        raise Hold(reason)


def plain(value):
    return " ".join(html.unescape(re.sub(r"<[^>]*>", " ", value)).split())


def number(value):
    result = float(plain(value))
    require(math.isfinite(result) and result >= 0, "invalid numeric evidence")
    return result


def duration(value):
    """Accept explicit units only; never guess a bare number's units."""
    text = plain(value).lower()
    units = {"d": DAY, "h": 3600, "m": 60, "s": 1}
    pattern = r"(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b"
    parts = re.findall(pattern, text)
    require(parts and not re.sub(pattern, "", text).strip(" ,"), "unknown tracker time format")
    return sum(float(n) * units[u[0]] for n, u in parts)


def tracker_account(page):
    require('href="/user/account/logout"' in page, "tracker session expired")
    cls = re.search(r"<td>Class</td>\s*<td>([^<]+)</td>", page)
    ratio = re.search(r'class="[^"]*profile-ratio-details[^"]*">([^<]+)<', page)
    require(cls and ratio, "tracker profile format changed")
    name = plain(cls.group(1))
    require(name in MIN_DAYS, "tracker class requires policy review")
    return name, number(ratio.group(1))


def tracker_clearance(page, torrent_id, minimum_days):
    table = re.search(r'<table\b[^>]*id="profile-snatchListTable"[^>]*>(.*?)</table>', page, re.S)
    require(table, "tracker snatchlist format changed")
    headers = [plain(x) for x in re.findall(r"<th\b[^>]*>(.*?)</th>", table.group(1), re.S)]
    require(headers[:11] == ["Name", "Size", "Sna", "Dld", "Uld", "Rto", "Ann", "Co", "Act.", "S.T.", "HnR"], "tracker columns changed")
    found = []
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", table.group(1), re.S):
        ids = re.findall(r'href=["\'](?:https://www\.torrentleech\.org)?/torrent/(\d+)["\']', row)
        if str(torrent_id) in ids:
            found.append(re.findall(r"<td\b[^>]*>(.*?)</td>", row, re.S))
    require(len(found) == 1 and len(found[0]) >= 11, "no unique tracker snatch record")
    cells = found[0]
    require(plain(cells[10]).lower() in {"no", "0", "false", "-"}, "tracker HnR status unclear or active")
    # Prefer explicit recorded time. Ratio is an alternative permitted by TL.
    try:
        seeded = duration(cells[9])
    except Hold:
        seeded = 0
    require(seeded >= minimum_days * DAY or number(cells[5]) >= 1.0, "tracker obligation not yet satisfied")


def safe_path(root, relative):
    rel = PurePosixPath(relative)
    require(not rel.is_absolute() and bool(rel.parts) and ".." not in rel.parts, "unsafe payload path")
    path = root.joinpath(*rel.parts)
    require(not any(p.is_symlink() for p in [path, *path.parents]), "symlink in payload/library path")
    require(path.resolve().is_relative_to(root.resolve()), "path outside approved root")
    return path


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").digest()


def stable_copy(source, target, expected_size):
    require(source.is_file() and target.is_file(), "imported file or mirror missing")
    before = (source.stat(), target.stat())
    require(all(s.st_size == expected_size for s in before), "file size differs from torrent")
    require(digest(source) == digest(target), "library bytes differ from download")
    after = (source.stat(), target.stat())
    require(all((a.st_ino, a.st_size, a.st_mtime_ns, a.st_ctime_ns) ==
                (b.st_ino, b.st_size, b.st_mtime_ns, b.st_ctime_ns)
                for a, b in zip(before, after)), "file changed during verification")


def import_proof(torrent, history, app, media=MEDIA):
    inbox = media / "sources/seedbox/deluge" / app
    library = media / "library" / ("tv" if app == "sonarr" else "films")
    imports = {}
    for event in history:
        if event["eventType"] == "downloadFolderImported":
            data = event["data"]
            imports.setdefault(data.get("droppedPath"), set()).add(data.get("importedPath"))
    count = 0
    for entry in torrent["files"]:
        rel = PurePosixPath(entry["path"])
        path = safe_path(inbox, entry["path"])
        require(path.is_file() and path.stat().st_size == entry["size"], "torrent payload not fully mirrored")
        suffix = rel.suffix.lower()
        # Samples and ancillary text/subtitles do not have Arr import events.
        sample = "sample" in [p.lower() for p in rel.parts[:-1]] or bool(re.search(r"(^|[._ -])sample([._ -]|$)", rel.stem, re.I))
        if suffix in VIDEO and not sample:
            candidates = imports.get("/media/sources/seedbox/deluge/" + app + "/" + str(rel), set())
            require(len(candidates) == 1 and None not in candidates, "missing or ambiguous media import receipt")
            imported = next(iter(candidates))
            prefix = "/media/library/" + ("tv/" if app == "sonarr" else "films/")
            require(imported.startswith(prefix), "import receipt outside library")
            target = safe_path(library, imported[len(prefix):])
            stable_copy(path, target, entry["size"])
            count += 1
        else:
            require((sample and suffix in VIDEO) or suffix in SIDECARS, "unaccounted payload type (archive/disc/extra)")
    require(count > 0, "no verified imported media")
    return count


def torrent_gate(torrent, minimum_days):
    require(torrent.get("label") in {"sonarr", "radarr"}, "unmanaged label")
    require(torrent.get("private") is True, "not a private tracker torrent")
    require(torrent.get("state") == "Seeding" and torrent.get("is_finished") is True and torrent.get("progress") == 100, "not fully seeding")
    require(torrent.get("save_path", "").rstrip("/") == REMOTE + "/" + torrent["label"], "outside managed completed directory")
    require(len(torrent.get("files", [])) > 0, "no payload manifest")
    require(len(torrent.get("file_progress", [])) == len(torrent["files"]) and all(x == 1 for x in torrent["file_progress"]), "partial torrent")
    require(len(torrent.get("file_priorities", [])) == len(torrent["files"]) and all(x > 0 for x in torrent["file_priorities"]), "selective download")
    # One full day above the account class minimum; never an early ratio shortcut.
    require(torrent.get("seeding_time", 0) >= (minimum_days + 1) * DAY, "minimum seeding time plus margin not reached")
    trackers = torrent.get("trackers", [])
    require(trackers and all(urllib.parse.urlsplit(t["url"]).hostname in
                            {"tracker.torrentleech.org", "tracker.torrentleech.cc"} for t in trackers), "unknown or mixed tracker policy")


def tracker_id(history):
    ids = set()
    for event in history:
        if event["eventType"] != "grabbed":
            continue
        url = urllib.parse.urlsplit(event["data"].get("nzbInfoUrl", ""))
        match = re.fullmatch(r"/torrent/(\d+)", url.path)
        if url.hostname == "www.torrentleech.org" and match:
            ids.add(match.group(1))
    require(len(ids) == 1, "missing unique TorrentLeech grab receipt")
    return ids.pop()


class Arr:
    def __init__(self, app):
        self.base = "http://127.0.0.1:" + {"sonarr": "8989", "radarr": "7878"}[app] + "/api/v3/"
        self.key = ET.parse(APPDATA / app / "config.xml").findtext("ApiKey")

    def get(self, path):
        with urllib.request.urlopen(urllib.request.Request(self.base + path, headers={"X-Api-Key": self.key}), timeout=30) as r:
            return json.load(r)

    def history(self, infohash):
        records = []
        for page in range(1, 101):
            data = self.get("history?" + urllib.parse.urlencode({"downloadId": infohash.upper(), "pageSize": 1000, "page": page}))
            records.extend(x for x in data["records"] if x.get("downloadId", "").lower() == infohash.lower())
            if page * 1000 >= data["totalRecords"]:
                return records
        raise Hold("history exceeds safe pagination limit")


class Deluge:
    def __init__(self, password):
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        require(self.call("auth.login", [password]) is True, "Deluge authentication failed")
        if not self.call("web.connected", []):
            hosts = self.call("web.get_hosts", [])
            require(len(hosts) == 1, "ambiguous provider daemon")
            self.call("web.connect", [hosts[0][0]])
        require(self.call("web.connected", []), "Deluge daemon disconnected")

    def call(self, method, params):
        request = urllib.request.Request("https://tiny.seedhost.eu/cosmicwhirl/deluge/json", data=json.dumps({"id": 1, "method": method, "params": params}).encode(), headers={"Content-Type": "application/json"})
        with self.opener.open(request, timeout=30) as r:
            result = json.load(r)
        require(not result.get("error"), "Deluge RPC failed: " + method)
        return result["result"]

    def torrents(self):
        fields = ["name", "label", "private", "save_path", "files", "file_progress", "file_priorities", "is_finished", "progress", "state", "seeding_time", "trackers"]
        return self.call("core.get_torrents_status", [{}, fields])


class Tracker:
    def __init__(self):
        # Reuse Prowlarr's authenticated session; no extra account password copy.
        with sqlite3.connect("file:" + str(APPDATA / "prowlarr/prowlarr.db") + "?mode=ro", uri=True) as db:
            rows = db.execute("SELECT s.Cookies, i.Settings FROM IndexerStatus s JOIN Indexers i ON i.Id=s.ProviderId WHERE i.Name='TorrentLeech'").fetchall()
        require(len(rows) == 1, "missing tracker session")
        cookies = json.loads(rows[0][0])
        settings = json.loads(rows[0][1])
        self.username = settings["extraFieldData"]["username"]
        require(re.fullmatch(r"[A-Za-z0-9_-]+", self.username), "unsupported tracker username")
        require(isinstance(cookies, dict) and cookies, "missing tracker cookies")
        self.headers = {"Cookie": "; ".join(k + "=" + v for k, v in cookies.items()), "User-Agent": "Mozilla/5.0"}
        self.last_request = 0

    def page(self, suffix):
        time.sleep(max(0, 4.2 - (time.monotonic() - self.last_request)))
        # Do not forward session cookies to another host via a redirect.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                raise Hold("tracker redirected; refresh session in Prowlarr")
        opener = urllib.request.build_opener(NoRedirect())
        with opener.open(urllib.request.Request(TRACKER + "/profile/" + self.username + "/" + suffix, headers=self.headers), timeout=30) as r:
            page = r.read().decode("utf-8")
        self.last_request = time.monotonic()
        require('href="/user/account/logout"' in page, "tracker session expired")
        return page


def run(apply, state_dir, password_file):
    arrs = {name: Arr(name) for name in ["sonarr", "radarr"]}
    clients = [c for c in arrs["sonarr"].get("downloadclient") if c["implementation"] == "Deluge" and c["enable"]]
    require(len(clients) == 1, "expected one enabled Deluge client")
    fields = {f["name"]: f.get("value") for f in clients[0]["fields"]}
    require(fields["host"] == "tiny.seedhost.eu", "unexpected Deluge endpoint")
    # Arr's REST API masks saved passwords; use the dedicated opnix secret.
    deluge = Deluge(password_file.read_text().strip())
    tracker = Tracker()
    account_class, ratio = tracker_account(tracker.page("view"))
    require(ratio >= 1.0, "overall ratio below conservative 1.0 floor; retain seeds")
    minimum = MIN_DAYS[account_class]
    torrents = deluge.torrents()
    report = {"checkedAt": int(time.time()), "apply": apply, "accountClass": account_class, "overallRatio": ratio, "torrents": {}}
    state_dir.mkdir(parents=True, exist_ok=True)
    state_path = state_dir / "eligible.json"
    previous = json.loads(state_path.read_text()) if state_path.exists() else {}
    eligible = {}
    snatches = None
    for infohash, torrent in torrents.items():
        try:
            torrent_gate(torrent, minimum)
            # Deluge deletion must not unlink payload used by a cross-seed.
            files = {str(PurePosixPath(torrent["save_path"]) / f["path"]) for f in torrent["files"]}
            for other_hash, other in torrents.items():
                if other_hash != infohash:
                    require(not files.intersection(str(PurePosixPath(other["save_path"]) / f["path"]) for f in other["files"]), "payload shared with another torrent")
            history = arrs[torrent["label"]].history(infohash)
            tid = tracker_id(history)
            if snatches is None:
                snatches = tracker.page("snatchlist")
            tracker_clearance(snatches, tid, minimum)
            count = import_proof(torrent, history, torrent["label"])
            fingerprint = hashlib.sha256(json.dumps(torrent["files"], sort_keys=True).encode()).hexdigest()
            old = previous.get(infohash, {})
            continuous = old.get("manifest") == fingerprint and time.time() - old.get("lastSeen", 0) < 3600
            eligible[infohash] = {"since": old["since"] if continuous else time.time(), "lastSeen": time.time(), "manifest": fingerprint}
            require(time.time() - eligible[infohash]["since"] >= 3600, "eligibility must remain proven for one hour")
            if apply:
                # Recheck the payload, complete state, tracker and overlap immediately before mutation.
                fresh = deluge.torrents()
                require(infohash in fresh, "torrent disappeared")
                torrent_gate(fresh[infohash], minimum)
                require(fresh[infohash]["files"] == torrent["files"], "manifest changed")
                for other_hash, other in fresh.items():
                    if other_hash != infohash:
                        require(not files.intersection(str(PurePosixPath(other["save_path"]) / f["path"]) for f in other["files"]), "new overlapping torrent")
                latest_class, latest_ratio = tracker_account(tracker.page("view"))
                require(latest_class == account_class and latest_ratio >= 1, "account policy changed")
                tracker_clearance(tracker.page("snatchlist"), tid, minimum)
                import_proof(fresh[infohash], arrs[torrent["label"]].history(infohash), torrent["label"])
                require(deluge.call("core.remove_torrent", [infohash, True]) is True, "Deluge did not confirm removal")
                eligible.pop(infohash, None)
            report["torrents"][infohash] = {"status": "removed" if apply else "eligible-dry-run", "verifiedMediaFiles": count}
        except Hold as error:
            report["torrents"][infohash] = {"status": "retained", "reason": str(error)}
    for path, data in [(state_path, eligible), (state_dir / "report.json", report)]:
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(data, indent=2) + "\n")
        temp.replace(path)
    print(json.dumps(report))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--state-dir", type=Path, default=Path("/var/lib/seedbox-cleanup"))
    parser.add_argument("--deluge-password-file", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        run(args.apply, args.state_dir, args.deluge_password_file)
    except Exception as error:
        # Never log HTTP response bodies, cookies, API keys or torrent passkeys.
        failure = {"checkedAt": int(time.time()), "status": "cleanup-interrupted", "reason": str(error) if isinstance(error, Hold) else type(error).__name__}
        args.state_dir.mkdir(parents=True, exist_ok=True)
        (args.state_dir / "report.json").write_text(json.dumps(failure) + "\n")
        (args.state_dir / "eligible.json").write_text("{}\n")
        print(json.dumps(failure))
        raise SystemExit(1)
