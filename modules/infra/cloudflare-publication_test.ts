import { test } from "node:test";
import {
  apiToken,
  canonical,
  Cloudflare,
  type Manifest,
  marker,
  reconcile,
  type RecordEntry,
  type Route,
  type State,
  validateManifest,
} from "./cloudflare-publication.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function equal(actual: unknown, expected: unknown): void {
  assert(
    canonical(actual) === canonical(expected),
    `${canonical(actual)} != ${canonical(expected)}`,
  );
}

async function rejects(
  fn: () => Promise<unknown>,
  text: string,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    assert(
      error instanceof Error && error.message.includes(text),
      String(error),
    );
    return;
  }
  throw new Error(`Expected error containing ${text}`);
}

function route(name = "app.leolab.party"): Route {
  return {
    hostname: name,
    service: "https://127.0.0.1:443",
    originRequest: {
      httpHostHeader: name,
      originServerName: name,
      noTLSVerify: false,
    },
  };
}

function manifest(routes: Route[] = [route()]): Manifest {
  return {
    accountId: "a".repeat(32),
    zoneId: "b".repeat(32),
    tunnelId: "11111111-2222-3333-4444-555555555555",
    domain: "leolab.party",
    owner: "nix:picard:cloudflare-publication",
    adoptExisting: [],
    routes,
  };
}

class FakeCloudflare {
  records: RecordEntry[] = [
    {
      id: "external",
      name: "link.leolab.party",
      type: "CNAME",
      content: "cname.short.io",
      proxied: false,
    },
  ];
  config: Record<string, unknown> & { ingress: Route[] } = {
    originRequest: { connectTimeout: 12 },
    "warp-routing": { enabled: true },
    ingress: [
      {
        hostname: "external.leolab.party",
        service: "http://192.0.2.1:8000",
      },
      { service: "http_status:404" },
    ],
  };
  calls: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }> = [];
  state?: State;
  saves = 0;
  failPost = false;
  lostPostResponse = false;
  denyTunnel = false;
  concurrentTunnelEdit = false;
  tunnelReads = 0;

  api = new Cloudflare("test-token", async (input, init) => {
    const url = new URL(String(input));
    assert(url.origin === "https://api.cloudflare.com");
    assert(
      (init?.headers as Record<string, string>).Authorization ===
        "Bearer test-token",
    );
    const path = url.pathname.replace("/client/v4", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, path: path + url.search, body });
    const response = (result: unknown, extra = {}) =>
      new Response(JSON.stringify({ success: true, result, ...extra }));
    const failure = () =>
      new Response(
        JSON.stringify({
          success: false,
          errors: [{ code: 1000, message: "Do not echo test-token" }],
        }),
        { status: 401 },
      );
    if (path.includes("/configurations")) {
      if (this.denyTunnel) return failure();
      if (method === "PUT") {
        this.config = structuredClone(body.config);
      } else if (++this.tunnelReads === 2 && this.concurrentTunnelEdit) {
        this.config.ingress.unshift({
          hostname: "new-manual.leolab.party",
          service: "http://192.0.2.2",
        });
      }
      return response({ source: "cloudflare", config: this.config });
    }
    if (path.endsWith("/dns_records")) {
      if (method === "POST") {
        if (this.failPost) {
          this.failPost = false;
          return failure();
        }
        const record = { id: `created-${this.records.length}`, ...body };
        this.records.push(record);
        if (this.lostPostResponse) {
          this.lostPostResponse = false;
          return failure();
        }
        return response(record);
      }
      const page = Number(url.searchParams.get("page") ?? 1);
      return response(this.records.slice((page - 1) * 100, page * 100), {
        result_info: { total_pages: Math.ceil(this.records.length / 100) },
      });
    }
    if (path.includes("/dns_records/")) {
      const id = path.split("/").at(-1);
      const record = this.records.find((item) => item.id === id);
      assert(record, `Unknown record ${id}`);
      if (method === "DELETE") {
        this.records = this.records.filter((item) => item !== record);
      }
      if (method === "PATCH") Object.assign(record, body);
      return response(record);
    }
    return response({ name: "leolab.party", account: { id: "a".repeat(32) } });
  });

  save = (state: State) => {
    this.state = structuredClone(state);
    this.saves++;
    return Promise.resolve();
  };

  run(config = manifest(), dryRun = false) {
    return reconcile(config, this.api, this.state, this.save, dryRun);
  }

  mutations() {
    return this.calls.filter((call) => call.method !== "GET");
  }
}

test("publication creates the route before DNS and preserves unrelated records and tunnel settings", async () => {
  const fake = new FakeCloudflare();
  await fake.run();
  equal(
    fake.mutations().map((call) => call.method),
    ["PUT", "POST"],
  );
  equal(fake.records[0].content, "cname.short.io");
  equal(fake.config.ingress, [
    route(),
    {
      hostname: "external.leolab.party",
      service: "http://192.0.2.1:8000",
    },
    { service: "http_status:404" },
  ]);
  equal(fake.config["warp-routing"], { enabled: true });
  equal(fake.config.originRequest, { connectTimeout: 12 });
  assert(fake.records[1].comment === marker(manifest()));
  assert(fake.records[1].proxied && fake.records[1].ttl === 1);
  equal(fake.state?.claims["app.leolab.party"], [route()]);
});

test("repeated reconciliation performs no Cloudflare writes", async () => {
  const fake = new FakeCloudflare();
  await fake.run();
  fake.calls = [];
  equal(await fake.run(), []);
  equal(fake.mutations(), []);
});

test("unpublishing the last service removes owned DNS before its route and keeps dashboard resources", async () => {
  const fake = new FakeCloudflare();
  await fake.run();
  fake.calls = [];
  await fake.run(manifest([]));
  equal(
    fake.mutations().map((call) => call.method),
    ["DELETE", "PUT"],
  );
  equal(
    fake.records.map((record) => record.name),
    ["link.leolab.party"],
  );
  assert(
    !fake.config.ingress.some((entry) => entry.hostname === "app.leolab.party"),
  );
  equal(fake.state?.claims, {});
});

test("empty desired state does not need tunnel permissions and does not adopt existing dashboard hosts", async () => {
  const fake = new FakeCloudflare();
  fake.denyTunnel = true;
  equal(await fake.run(manifest([])), []);
  equal(fake.tunnelReads, 0);
  equal(fake.saves, 0);
  equal(fake.mutations(), []);
});

test("dry-run reads a plan without writes to Cloudflare or local state", async () => {
  const fake = new FakeCloudflare();
  equal(
    (await fake.run(manifest(), true)).map((action) => action.operation),
    ["create-dns", "update-tunnel"],
  );
  equal(fake.saves, 0);
  equal(fake.mutations(), []);
});

test("unmanaged DNS collisions abort before claiming or changing resources", async () => {
  for (const type of ["A", "AAAA", "CNAME", "NS"]) {
    const fake = new FakeCloudflare();
    fake.records.push({
      id: "collision",
      name: "app.leolab.party",
      type,
      content: "somewhere-else.example",
      proxied: true,
    });
    await rejects(() => fake.run(), "Unmanaged DNS record");
    equal(fake.saves, 0);
    equal(fake.mutations(), []);
  }
});

test("matching existing DNS and tunnel routes require explicit adoption", async () => {
  const fake = new FakeCloudflare();
  const config = manifest();
  fake.records.push({
    id: "adopt",
    name: "app.leolab.party",
    type: "CNAME",
    content: `${config.tunnelId}.cfargotunnel.com`,
    proxied: true,
    ttl: 1,
    comment: "keep this note",
  });
  fake.config.ingress.unshift({
    hostname: "app.leolab.party",
    service: "https://localhost:443",
  });
  await rejects(() => fake.run(), "Unmanaged DNS record");
  config.adoptExisting = ["app.leolab.party"];
  await fake.run(config);
  assert(fake.records[1].comment?.includes("keep this note"));
  assert(fake.records[1].comment?.includes(marker(config)));
  equal(fake.config.ingress[0], route());
});

test("an unmanaged tunnel route alone also needs adoption", async () => {
  const fake = new FakeCloudflare();
  fake.config.ingress.unshift(route());
  await rejects(
    () => fake.run(),
    "Unmanaged or externally changed tunnel route",
  );
  equal(fake.saves, 0);
  equal(fake.mutations(), []);
});

test("external changes to an owned route are reported rather than overwritten", async () => {
  const fake = new FakeCloudflare();
  await fake.run();
  fake.config.ingress[0].service = "http://192.0.2.99";
  fake.calls = [];
  await rejects(() => fake.run(), "externally changed tunnel route");
  equal(fake.mutations(), []);
});

test("a DNS failure after publishing a route is recoverable from saved intent", async () => {
  const fake = new FakeCloudflare();
  fake.failPost = true;
  await rejects(() => fake.run(), "HTTP 401");
  equal(fake.state?.claims["app.leolab.party"], [route()]);
  fake.calls = [];
  await fake.run();
  equal(
    fake.mutations().map((call) => call.method),
    ["POST"],
  );
});

test("a lost DNS creation response does not create duplicates on retry", async () => {
  const fake = new FakeCloudflare();
  fake.lostPostResponse = true;
  await rejects(() => fake.run(), "HTTP 401");
  fake.calls = [];
  await fake.run();
  equal(fake.mutations(), []);
  equal(
    fake.records.filter((record) => record.name === "app.leolab.party").length,
    1,
  );
});

test("ownership comments recover generated routes after a lost state file, including withdrawal", async () => {
  const fake = new FakeCloudflare();
  await fake.run();
  fake.state = undefined;
  fake.calls = [];
  await fake.run(manifest([]));
  equal(
    fake.mutations().map((call) => call.method),
    ["DELETE", "PUT"],
  );
});

test("concurrent tunnel edits abort the full-configuration update", async () => {
  const fake = new FakeCloudflare();
  fake.concurrentTunnelEdit = true;
  await rejects(() => fake.run(), "changed during reconciliation");
  equal(fake.mutations(), []);
});

test("public root publication retains mail records", async () => {
  const fake = new FakeCloudflare();
  fake.records.push({
    id: "mail",
    name: "leolab.party",
    type: "MX",
    content: "mail.example",
  });
  fake.records.push({
    id: "spf",
    name: "leolab.party",
    type: "TXT",
    content: "v=spf1 -all",
  });
  await fake.run(manifest([route("leolab.party")]));
  assert(fake.records.some((record) => record.id === "mail"));
  assert(fake.records.some((record) => record.id === "spf"));
});

test("webhooks route through the existing Caddy HTTP listener", async () => {
  const fake = new FakeCloudflare();
  const webhook: Route = {
    hostname: "webhooks.leolab.party",
    service: "http://127.0.0.1:80",
    originRequest: { httpHostHeader: "webhooks.leolab.party" },
  };
  await fake.run(manifest([webhook]));
  equal(fake.config.ingress[0], webhook);
});

test("owned records on later API pages are still withdrawn", async () => {
  const fake = new FakeCloudflare();
  fake.records = Array.from({ length: 100 }, (_, index) => ({
    id: `manual-${index}`,
    name: `manual-${index}.leolab.party`,
    type: "A",
    content: "192.0.2.1",
  }));
  await fake.run();
  fake.state = undefined;
  fake.calls = [];
  await fake.run(manifest([]));
  equal(fake.records.length, 100);
  assert(fake.calls.some((call) => call.path.includes("page=2")));
});

test("API failures do not log tokens or change resources", async () => {
  const fake = new FakeCloudflare();
  fake.denyTunnel = true;
  await rejects(() => fake.run(), "HTTP 401; codes 1000");
  equal(fake.mutations(), []);
  equal(fake.saves, 0);
});

test("multi-rule and path-specific hostnames cannot be silently adopted", async () => {
  for (const rules of [
    [{ ...route(), path: "/private" }],
    [route(), route()],
  ]) {
    const fake = new FakeCloudflare();
    fake.config.ingress.unshift(...rules);
    const config = manifest();
    config.adoptExisting = ["app.leolab.party"];
    await rejects(() => fake.run(config), "multiple or path-specific");
    equal(fake.mutations(), []);
  }
});

test("foreign state fails before any Cloudflare request", async () => {
  const fake = new FakeCloudflare();
  fake.state = {
    version: 1,
    identity: "a different tunnel",
    claims: { "app.leolab.party": [route()] },
  };
  await rejects(() => fake.run(), "different account");
  equal(fake.calls, []);
});

test("manifest validation prevents publishing outside the zone or bypassing Caddy", () => {
  for (const bad of [
    route("app.other.example"),
    {
      ...route(),
      service: "http://127.0.0.1:8000",
    },
    { ...route(), originRequest: { noTLSVerify: true } },
  ]) {
    let failed = false;
    try {
      validateManifest(manifest([bad]));
    } catch {
      failed = true;
    }
    assert(failed);
  }
});

test("token files accept raw tokens and existing ACME dotenv credentials", () => {
  equal(apiToken("test-token\n"), "test-token");
  equal(apiToken('CF_DNS_API_TOKEN="test-token"\n'), "test-token");
  equal(apiToken("export CLOUDFLARE_API_TOKEN='test-token'\n"), "test-token");
});
