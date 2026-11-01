import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { TransferService, syncPath } from "./transfer.ts";

test("only known inbox paths map to Syncthing, with segment boundaries", () => {
  assert.equal(
    syncPath("/home3/cosmicwhirl/downloads/complete/deluge/sonarr/Show/"),
    "deluge/sonarr/Show",
  );
  assert.equal(
    syncPath("/media/sources/seedbox/deluge/radarr/Movie.mkv"),
    "deluge/radarr/Movie.mkv",
  );
  for (const path of [
    "/secret",
    "/media/sources/seedbox/deluge/sonarr/../secret",
    "/media/sources/seedbox/deluge/manual/file",
    "/media/sources/seedbox/deluge/sonarr",
    "/media/sources/seedbox/deluge/sonarr//file",
  ])
    assert.equal(syncPath(path), undefined);
});
test("transfer stages require matching active or queued files; missing, truncated and failed responses stay unknown", async (t) => {
  let fail = false;
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    assert.equal(req.method, "GET");
    assert.equal(req.headers["x-api-key"], "private-key");
    const url = new URL(req.url!, "http://localhost");
    assert.equal(url.pathname, "/rest/db/need");
    assert.equal(url.searchParams.get("folder"), "seedhost-completed");
    assert.equal(url.searchParams.get("perpage"), "1000");
    res.writeHead(fail ? 503 : 200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        progress: [{ name: "deluge/sonarr/Show/ep.mkv" }],
        queued: [{ name: "deluge/radarr/Movie.mkv" }],
        rest: [],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const service = new TransferService({
    url: `http://127.0.0.1:${address.port}`,
    apiKey: "private-key",
    folder: "seedhost-completed",
  });
  const paths = new Map([
    ["tv:1", "/media/sources/seedbox/deluge/sonarr/Show"],
    ["movie:2", "/media/sources/seedbox/deluge/radarr/Movie.mkv"],
    ["tv:3", "/media/sources/seedbox/deluge/sonarr/Show2"],
  ]);
  const states = await service.states(paths);
  assert.equal(states.get("tv:1"), "transferring_to_server");
  assert.equal(states.get("movie:2"), "queued_for_transfer");
  assert.equal(states.get("tv:3"), "unknown");
  assert.equal(calls, 1);
  fail = true;
  assert.equal((await service.states(paths)).size, 0);
  const before = calls;
  assert.equal((await service.states(new Map([["bad", "/unknown"]]))).size, 0);
  assert.equal(calls, before);
});
