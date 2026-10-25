import { z } from "../vendor/zod/index.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Resolver } from "node:dns/promises";

const run = promisify(execFile);
const Arguments = z.object({
  mounts: z.array(z.object({ path: z.string(), source: z.string() })),
  dnsServer: z.string(),
  dnsNames: z.array(z.string()),
  expectedAddress: z.string(),
  endpoints: z.array(z.object({ name: z.string(), url: z.string().url() })),
});
const Check = z.object({
  name: z.string(),
  ok: z.boolean(),
  detail: z.string(),
});
const Snapshot = z.object({
  observedAt: z.string(),
  host: z.string(),
  ok: z.boolean(),
  checks: z.array(Check),
});

type CheckResult = { name: string; ok: boolean; detail: string };
type Context = {
  globalArgs: {
    mounts: { path: string; source: string }[];
    dnsServer: string;
    dnsNames: string[];
    expectedAddress: string;
    endpoints: { name: string; url: string }[];
  };
  writeResource(spec: string, name: string, value: unknown): Promise<unknown>;
};

async function check(
  name: string,
  action: () => Promise<string>,
): Promise<CheckResult> {
  try {
    return { name, ok: true, detail: await action() };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error
        ? error.message.slice(0, 1000)
        : String(error),
    };
  }
}

export const behavior = {
  type: "@leo/picard-health",
  version: "2026.10.25.1",
  globalArguments: Arguments,
  resources: {
    snapshot: {
      description: "Picard service, storage, DNS, and HTTP health snapshot",
      schema: Snapshot,
      lifetime: "7d",
      garbageCollection: 672,
    },
  },
  methods: {
    collect: {
      description: "Collect bounded read-only health checks on this host",
      arguments: z.object({}),
      async execute(_args: Record<string, never>, context: Context) {
        const args = context.globalArgs;
        const resolver = new Resolver({ timeout: 3000, tries: 1 });
        resolver.setServers([args.dnsServer]);
        const checks = await Promise.all([
          check("failed-services", async () => {
            const { stdout } = await run("systemctl", [
              "--failed",
              "--type=service",
              "--no-legend",
              "--plain",
              "--no-pager",
            ], { timeout: 10000, maxBuffer: 65536 });
            if (stdout.trim()) throw new Error(stdout.trim());
            return "No failed system services";
          }),
          ...args.mounts.map((mount) =>
            check(`mount:${mount.path}`, async () => {
              const { stdout } = await run("findmnt", [
                "--mountpoint",
                mount.path,
                "--json",
                "--output",
                "TARGET,SOURCE,FSTYPE",
              ], { timeout: 10000, maxBuffer: 65536 });
              const entry = JSON.parse(stdout).filesystems?.[0];
              if (
                entry?.target !== mount.path ||
                entry?.source !== mount.source || entry?.fstype !== "virtiofs"
              ) {
                throw new Error(
                  `Expected virtiofs ${mount.source} at ${mount.path}; got ${
                    JSON.stringify(entry)
                  }`,
                );
              }
              return `${entry.source} mounted as ${entry.fstype}`;
            })
          ),
          ...args.dnsNames.map((name) =>
            check(`dns:${name}`, async () => {
              const addresses = await resolver.resolve4(name);
              if (
                addresses.length !== 1 || addresses[0] !== args.expectedAddress
              ) {
                throw new Error(
                  `Expected ${args.expectedAddress}; got ${
                    addresses.join(", ")
                  }`,
                );
              }
              return `${name} -> ${addresses[0]} via ${args.dnsServer}`;
            })
          ),
          ...args.endpoints.map((endpoint) =>
            check(`http:${endpoint.name}`, async () => {
              const started = performance.now();
              const response = await fetch(endpoint.url, {
                redirect: "manual",
                signal: AbortSignal.timeout(10000),
              });
              await response.body?.cancel();
              if (!response.ok) throw new Error(`HTTP ${response.status}`);
              return `HTTP ${response.status} in ${
                Math.round(performance.now() - started)
              }ms`;
            })
          ),
        ]);
        const snapshot = {
          observedAt: new Date().toISOString(),
          host: Deno.hostname(),
          ok: checks.every((entry) => entry.ok),
          checks,
        };
        const handle = await context.writeResource(
          "snapshot",
          "snapshot",
          snapshot,
        );
        console.log(JSON.stringify(snapshot));
        return { dataHandles: [handle] };
      },
    },
  },
};
