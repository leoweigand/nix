import { behavior } from "./picard-health.ts";

Deno.test("records failed checks as evidence without losing the snapshot", async () => {
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com" },
      }),
  );
  try {
    let snapshot:
      | { ok: boolean; checks: { name: string; ok: boolean }[] }
      | undefined;
    const result = await behavior.methods.collect.execute({}, {
      globalArgs: {
        mounts: [{ path: "/nonexistent-swamp-test-mount", source: "missing" }],
        dnsServer: "192.168.2.4",
        dnsNames: ["auth.leolab.party"],
        expectedAddress: "192.0.2.123",
        endpoints: [{
          name: "redirect",
          url: `http://127.0.0.1:${server.addr.port}`,
        }],
      },
      writeResource(_spec, _name, value) {
        snapshot = value as typeof snapshot;
        return Promise.resolve("saved");
      },
    });
    if (!snapshot || snapshot.ok) {
      throw new Error("Failed checks must produce an unhealthy snapshot");
    }
    for (
      const name of [
        "mount:/nonexistent-swamp-test-mount",
        "dns:auth.leolab.party",
        "http:redirect",
      ]
    ) {
      if (snapshot.checks.find((entry) => entry.name === name)?.ok !== false) {
        throw new Error(`Expected failed evidence for ${name}`);
      }
    }
    if (result.dataHandles[0] !== "saved") {
      throw new Error("Snapshot handle was not returned");
    }
  } finally {
    await server.shutdown();
  }
});
