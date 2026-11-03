// Test-process-only routing: exercise real HTTP and JWT verification without
// contacting live lab services. Production never loads this module.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const source = new URL(input instanceof Request ? input.url : String(input));
  if (["auth.leolab.party", "mcp.leolab.party"].includes(source.hostname)) {
    const target = new URL(process.env.EVE_FIXTURE_URL);
    source.host = target.host;
    source.protocol = target.protocol;
    return originalFetch(
      input instanceof Request ? new Request(source, input) : source,
      init,
    );
  }
  if (!["127.0.0.1", "localhost"].includes(source.hostname))
    throw new Error(`Unexpected fixture network destination: ${source.origin}`);
  return originalFetch(input, init);
};
