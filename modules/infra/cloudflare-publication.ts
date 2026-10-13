import { restrictedFetch } from "../runtime/network.ts";
import { open, readFile, rename } from "node:fs/promises";

const automationFetch = restrictedFetch(["https://api.cloudflare.com"]);

export interface Route {
  hostname?: string;
  service: string;
  path?: string;
  originRequest?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Manifest {
  accountId: string;
  zoneId: string;
  tunnelId: string;
  domain: string;
  owner: string;
  adoptExisting: string[];
  routes: Route[];
}

export interface State {
  version: 1;
  identity: string;
  claims: Record<string, Route[]>;
}

export interface RecordEntry {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string | null;
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number }>;
  result_info?: { total_pages?: number };
}

export class Cloudflare {
  private token: string;
  private fetcher: typeof fetch;

  constructor(token: string, fetcher = automationFetch) {
    this.token = token;
    this.fetcher = fetcher;
  }

  async request<T>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Envelope<T>> {
    const response = await this.fetcher(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    let envelope: Envelope<T>;
    try {
      envelope = await response.json();
    } catch {
      throw new Error(
        `Cloudflare ${method} ${path} returned non-JSON (HTTP ${response.status})`,
      );
    }
    if (
      !response.ok ||
      envelope.success !== true ||
      !Object.hasOwn(envelope, "result")
    ) {
      // Do not log response bodies or credentials; permission failures still include API error codes.
      const codes =
        envelope.errors?.map((error) => error.code).join(",") ?? "unknown";
      throw new Error(
        `Cloudflare ${method} ${path} failed (HTTP ${response.status}; codes ${codes})`,
      );
    }
    return envelope;
  }

  async records(zoneId: string): Promise<RecordEntry[]> {
    const records: RecordEntry[] = [];
    for (let page = 1; page <= 1000; page++) {
      const reply = await this.request<RecordEntry[]>(
        `/zones/${zoneId}/dns_records?per_page=100&page=${page}`,
      );
      if (!Array.isArray(reply.result)) {
        throw new Error("Cloudflare returned an invalid DNS record list");
      }
      records.push(...reply.result);
      const total = reply.result_info?.total_pages;
      if (total === undefined ? reply.result.length < 100 : page >= total) {
        return records;
      }
    }
    throw new Error("Cloudflare DNS pagination exceeded 1000 pages");
  }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function hostname(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}

export function validateManifest(config: Manifest): void {
  if (
    !/^[a-f0-9]{32}$/.test(config.accountId) ||
    !/^[a-f0-9]{32}$/.test(config.zoneId) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(config.tunnelId)
  ) {
    throw new Error("Invalid Cloudflare account, zone or tunnel ID");
  }
  if (
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(config.domain) ||
    !/^[a-zA-Z0-9:._-]{1,120}$/.test(config.owner) ||
    !Array.isArray(config.routes) ||
    !Array.isArray(config.adoptExisting)
  ) {
    throw new Error("Invalid publication manifest");
  }
  const seen = new Set<string>();
  for (const route of config.routes) {
    const name = route.hostname;
    if (
      !name ||
      (name !== config.domain &&
        !new RegExp(
          `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.${config.domain.replaceAll(
            ".",
            "\\.",
          )}$`,
        ).test(name)) ||
      seen.has(name)
    ) {
      throw new Error(`Invalid or duplicate public hostname: ${name}`);
    }
    if (
      route.path ||
      !["https://127.0.0.1:443", "http://127.0.0.1:80"].includes(
        route.service,
      ) ||
      route.originRequest?.httpHostHeader !== name ||
      (route.service.startsWith("https:") &&
        (route.originRequest?.originServerName !== name ||
          route.originRequest?.noTLSVerify !== false))
    ) {
      throw new Error(
        `Public hostname ${name} must route through Caddy with the correct Host and TLS identity`,
      );
    }
    seen.add(name);
  }
  if (config.adoptExisting.some((name) => !seen.has(name))) {
    throw new Error(
      "adoptExisting must contain only explicitly public hostnames",
    );
  }
}

function identity(config: Manifest): string {
  return [config.owner, config.accountId, config.zoneId, config.tunnelId].join(
    "/",
  );
}

export function marker(config: Manifest): string {
  return `managed-by=${config.owner};tunnel=${config.tunnelId}`;
}

function owned(record: RecordEntry, config: Manifest): boolean {
  return record.comment?.split("\n").includes(marker(config)) ?? false;
}

function validateState(state: State, config: Manifest): void {
  if (
    state.version !== 1 ||
    !state.claims ||
    typeof state.claims !== "object" ||
    Array.isArray(state.claims)
  ) {
    throw new Error(
      "Invalid publication state; restore its backup rather than discarding ownership information",
    );
  }
  if (
    state.identity !== identity(config) &&
    Object.keys(state.claims).length > 0
  ) {
    throw new Error(
      "Publication state belongs to a different account, zone, tunnel or owner",
    );
  }
  for (const [name, claims] of Object.entries(state.claims)) {
    if (
      (name !== config.domain && !name.endsWith(`.${config.domain}`)) ||
      !Array.isArray(claims) ||
      claims.length === 0 ||
      claims.some(
        (route) => route.hostname !== name || typeof route.service !== "string",
      )
    ) {
      throw new Error("Invalid route ownership in publication state");
    }
  }
}

interface TunnelConfig {
  ingress: Route[];
  [key: string]: unknown;
}

interface TunnelReply {
  source?: string;
  config: TunnelConfig;
}

interface Action {
  operation: string;
  hostname?: string;
}

export async function reconcile(
  config: Manifest,
  api: Cloudflare,
  previous: State | undefined,
  save: (state: State) => Promise<void>,
  dryRun = false,
): Promise<Action[]> {
  validateManifest(config);
  if (previous) validateState(previous, config);
  const state: State =
    previous && previous.identity === identity(config)
      ? structuredClone(previous)
      : { version: 1, identity: identity(config), claims: {} };
  const zonePath = `/zones/${config.zoneId}`;
  const zone = (
    await api.request<{ name: string; account: { id: string } }>(zonePath)
  ).result;
  if (zone.name !== config.domain || zone.account.id !== config.accountId) {
    throw new Error(
      "Cloudflare zone does not match the declared domain and account",
    );
  }
  const records = await api.records(config.zoneId);
  const ownedRecords = records.filter((record) => owned(record, config));
  if (
    config.routes.length === 0 &&
    ownedRecords.length === 0 &&
    Object.keys(state.claims).length === 0
  )
    return [];

  const tunnelPath = `/accounts/${config.accountId}/cfd_tunnel/${config.tunnelId}/configurations`;
  const current = (await api.request<TunnelReply>(tunnelPath)).result;
  if (
    current.source !== "cloudflare" ||
    !Array.isArray(current.config?.ingress) ||
    current.config.ingress.length === 0
  ) {
    throw new Error(
      "Publication requires a remotely managed tunnel with a valid ingress configuration",
    );
  }
  const catchAll = (route: Route) => !route.hostname && !route.path;
  if (
    !catchAll(current.config.ingress.at(-1)!) ||
    current.config.ingress.slice(0, -1).some(catchAll)
  ) {
    throw new Error(
      "Tunnel configuration must end with exactly one catch-all rule",
    );
  }

  const target = `${config.tunnelId}.cfargotunnel.com`;
  const desired = new Map(
    config.routes.map((route) => [route.hostname!, route]),
  );
  const adopted = new Set(config.adoptExisting);
  const managed = new Set([
    ...Object.keys(state.claims),
    ...ownedRecords.map((record) => hostname(record.name)),
    ...desired.keys(),
  ]);
  const dnsPlans: Array<{
    route: Route;
    record?: RecordEntry;
    body: Record<string, unknown>;
  }> = [];
  const actions: Action[] = [];

  // Validate all collisions before changing either Cloudflare or local ownership state.
  for (const route of config.routes) {
    const name = route.hostname!;
    const collisions = records.filter(
      (record) =>
        hostname(record.name) === name &&
        ["A", "AAAA", "CNAME", "NS"].includes(record.type),
    );
    if (collisions.length > 1) {
      throw new Error(
        `Multiple DNS records conflict with publication of ${name}`,
      );
    }
    const record = collisions[0];
    if (
      record &&
      !owned(record, config) &&
      (!adopted.has(name) ||
        record.type !== "CNAME" ||
        hostname(record.content) !== target ||
        !record.proxied)
    ) {
      throw new Error(
        `Unmanaged DNS record conflicts with ${name}; matching tunnel CNAMEs require explicit adoptExisting`,
      );
    }
    const comment =
      record && owned(record, config)
        ? record.comment!
        : [marker(config), record?.comment].filter(Boolean).join("\n");
    const body = {
      name,
      type: "CNAME",
      content: target,
      proxied: true,
      ttl: 1,
      comment,
    };
    if (
      !record ||
      Object.entries(body).some(([key, value]) =>
        key === "content"
          ? hostname(record.content) !== value
          : record[key as keyof RecordEntry] !== value,
      )
    ) {
      dnsPlans.push({ route, record, body });
      actions.push({
        operation: record ? "update-dns" : "create-dns",
        hostname: name,
      });
    }
  }

  for (const name of managed) {
    const existing = current.config.ingress.filter(
      (route) => route.hostname && hostname(route.hostname) === name,
    );
    if (existing.length > 1 || existing.some((route) => route.path)) {
      throw new Error(
        `Cannot manage multiple or path-specific tunnel rules for ${name}`,
      );
    }
    const claim = state.claims[name] ?? [];
    const wanted = desired.get(name);
    if (
      existing.length > 0 &&
      !claim.some((rule) => canonical(rule) === canonical(existing[0]))
    ) {
      // DNS ownership can recover a lost state file only for our known, generated route shape.
      const recovery = wanted ?? {
        hostname: name,
        service:
          name === `webhooks.${config.domain}`
            ? "http://127.0.0.1:80"
            : "https://127.0.0.1:443",
        originRequest: {
          httpHostHeader: name,
          ...(name === `webhooks.${config.domain}`
            ? {}
            : { originServerName: name, noTLSVerify: false }),
        },
      };
      const recoverable =
        ownedRecords.some((record) => hostname(record.name) === name) &&
        canonical(existing[0]) === canonical(recovery);
      if (
        !recoverable &&
        !(claim.length === 0 && wanted && adopted.has(name))
      ) {
        throw new Error(
          `Unmanaged or externally changed tunnel route conflicts with ${name}; use explicit adoption for existing routes`,
        );
      }
    }
    // Persist the old and intended route before API writes, so interrupted runs can resume safely.
    const claims = [...claim, ...existing, ...(wanted ? [wanted] : [])];
    if (claims.length) {
      state.claims[name] = [
        ...new Map(claims.map((rule) => [canonical(rule), rule])).values(),
      ];
    }
  }

  const staleRecords = ownedRecords.filter(
    (record) => !desired.has(hostname(record.name)),
  );
  for (const record of staleRecords) {
    actions.push({ operation: "delete-dns", hostname: record.name });
  }
  const nextConfig: TunnelConfig = {
    ...current.config,
    ingress: [
      ...[...desired.values()].sort((a, b) =>
        a.hostname!.localeCompare(b.hostname!),
      ),
      ...current.config.ingress.filter(
        (route) => !route.hostname || !managed.has(hostname(route.hostname)),
      ),
    ],
  };
  const tunnelChanged = canonical(nextConfig) !== canonical(current.config);
  if (tunnelChanged) actions.push({ operation: "update-tunnel" });
  if (dryRun) return actions;
  await save(state);

  // Withdraw DNS before routes; publish routes before DNS. Unmanaged resources are never deleted.
  for (const record of staleRecords) {
    const path = `${zonePath}/dns_records/${encodeURIComponent(record.id)}`;
    const latest = (await api.request<RecordEntry>(path)).result;
    if (!owned(latest, config)) {
      throw new Error(`DNS ownership changed before removal of ${record.name}`);
    }
    await api.request(path, "DELETE");
  }
  if (tunnelChanged) {
    const latest = (await api.request<TunnelReply>(tunnelPath)).result;
    if (canonical(latest.config) !== canonical(current.config)) {
      throw new Error(
        "Tunnel configuration changed during reconciliation; retry with the new configuration",
      );
    }
    await api.request(tunnelPath, "PUT", { config: nextConfig });
  }
  for (const { route, record, body } of dnsPlans) {
    if (record) {
      const path = `${zonePath}/dns_records/${encodeURIComponent(record.id)}`;
      const latest = (await api.request<RecordEntry>(path)).result;
      if (
        !owned(latest, config) &&
        (!adopted.has(route.hostname!) ||
          canonical(latest) !== canonical(record))
      ) {
        throw new Error(
          `DNS ownership changed before updating ${route.hostname}`,
        );
      }
      await api.request(path, "PATCH", body);
    } else {
      await api.request(`${zonePath}/dns_records`, "POST", body);
    }
  }
  await save({
    version: 1,
    identity: identity(config),
    claims: Object.fromEntries(
      [...desired].map(([name, route]) => [name, [route]]),
    ),
  });
  return actions;
}

export function apiToken(contents: string): string {
  const text = contents.trim();
  const match =
    /^(?:export\s+)?(?:CLOUDFLARE_API_TOKEN|CF_DNS_API_TOKEN)\s*=\s*(.*?)\s*$/m.exec(
      text,
    );
  const value = match ? match[1].replace(/^(["'])(.*)\1$/, "$2") : text;
  if (!value || /\s/.test(value) || value.includes("=")) {
    throw new Error("Invalid Cloudflare API token file");
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string): string => {
    const index = args.indexOf(name);
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith("--")) {
      throw new Error(`Missing ${name}`);
    }
    return args[index + 1];
  };
  const config: Manifest = JSON.parse(
    await readFile(value("--config"), "utf8"),
  );
  validateManifest(config);
  const token = apiToken(await readFile(value("--token-file"), "utf8"));
  const statePath = value("--state");
  let state: State | undefined;
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const save = async (next: State) => {
    const temporary = `${statePath}.${crypto.randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(next) + "\n");
      let offset = 0;
      while (offset < bytes.length) {
        offset += (await file.write(bytes.subarray(offset))).bytesWritten;
      }
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, statePath);
  };
  const dryRun = args.includes("--dry-run");
  const actions = await reconcile(
    config,
    new Cloudflare(token),
    state,
    save,
    dryRun,
  );
  console.log(
    JSON.stringify({
      dryRun,
      actions,
      message: actions.length
        ? "Publication reconciled"
        : "Publication already matches the declarations",
    }),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Cloudflare publication failed",
    );
    process.exit(1);
  }
}
