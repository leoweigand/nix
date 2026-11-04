import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest } from "node:https";

export const MAX_BODY = 1024 * 1024;
export const MAX_RESPONSE = 2 * 1024 * 1024;
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");
export function publicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !blocked.check(address, "ipv4")
    : family === 6 &&
        globalV6.check(address, "ipv6") &&
        !blocked.check(address, "ipv6");
}
export function validateNetwork(network: unknown): void {
  if (network === undefined) return;
  const value = network as { server?: unknown };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "server") ||
    !Array.isArray(value.server) ||
    value.server.length > 16
  )
    throw new Error(
      "network must contain server: an array of at most 16 HTTPS origins",
    );
  for (const origin of value.server) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("Invalid server origin");
    }
    if (
      typeof origin !== "string" ||
      origin.length > 300 ||
      url.origin !== origin ||
      url.protocol !== "https:" ||
      url.port ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      !url.hostname.includes(".") ||
      !/^[a-z0-9.-]+$/.test(url.hostname) ||
      url.hostname.endsWith(".")
    )
      throw new Error(
        "Server destinations must be exact HTTPS DNS origins on port 443, without paths or credentials",
      );
  }
}
export interface OutboundRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
type Address = { address: string; family: number };
export async function resolvePublic(
  hostname: string,
  resolve = lookup,
): Promise<Address[]> {
  const addresses = await resolve(hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some((entry) => !publicAddress(entry.address))
  )
    throw new Error("Server fetch cannot reach private or reserved addresses");
  return addresses;
}
function headersFor(input: Record<string, string>) {
  const headers = new Headers(input);
  for (const name of [...headers.keys()])
    if (
      /^(cookie|host|connection|content-length|transfer-encoding|upgrade|te|trailer|expect|proxy-.*|x-now-.*|x-auth-.*|x-forwarded-.*|remote-user)$/i.test(
        name,
      )
    )
      headers.delete(name);
  // The broker buffers bytes and does not decode compression.
  headers.set("accept-encoding", "identity");
  return headers;
}
export function requestPinned(
  url: URL,
  method: string,
  headers: Headers,
  body: Buffer,
  addresses: Address[],
  signal: AbortSignal,
  transport = httpsRequest,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const pinned = addresses[0]!;
    const request = transport(
      url,
      {
        method,
        headers: Object.fromEntries(headers),
        signal,
        // Keep the original hostname for TLS/SNI, but never resolve it again.
        family: pinned.family,
        autoSelectFamily: false,
        agent: false,
        lookup: (_host, _options, callback) =>
          callback(null, pinned.address, pinned.family),
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on("error", reject);
        incoming.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE)
            request.destroy(new Error("Outbound response exceeds 2 MiB"));
          else chunks.push(chunk);
        });
        incoming.on("end", () => {
          try {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(incoming.headers))
              if (
                value !== undefined &&
                !/^(set-cookie|connection|transfer-encoding|content-length|upgrade|trailer)$/i.test(
                  name,
                )
              )
                responseHeaders.set(
                  name,
                  Array.isArray(value) ? value.join(", ") : value,
                );
            const status = incoming.statusCode ?? 502;
            resolve(
              new Response(
                method === "HEAD" || [204, 205, 304].includes(status)
                  ? null
                  : Buffer.concat(chunks),
                {
                  status,
                  headers: responseHeaders,
                },
              ),
            );
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}
export async function fetchPublic(
  input: OutboundRequest,
  origins: string[],
  options: {
    resolve?: typeof lookup;
    request?: typeof requestPinned;
    timeoutMs?: number;
  } = {},
): Promise<Response> {
  validateNetwork({ server: origins });
  if (
    !input ||
    typeof input.url !== "string" ||
    input.url.length > 8192 ||
    !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
      input.method,
    ) ||
    typeof input.body !== "string" ||
    input.body.length > Math.ceil(MAX_BODY / 3) * 4
  )
    throw new Error("Invalid outbound request or body exceeds 1 MiB");
  let url = new URL(input.url),
    method = input.method;
  let bytes = Buffer.from(input.body, "base64"),
    headers = headersFor(input.headers);
  if (bytes.length > MAX_BODY) throw new Error("Outbound body exceeds 1 MiB");
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error("Server fetch timed out")),
    options.timeoutMs ?? 10_000,
  );
  const work = async () => {
    for (let redirect = 0; redirect <= 3; redirect++) {
      if (
        url.username ||
        url.password ||
        url.protocol !== "https:" ||
        !origins.includes(url.origin)
      )
        throw new Error(
          `Server origin ${url.origin} is not declared in network.server`,
        );
      const addresses = await resolvePublic(url.hostname, options.resolve);
      deadline.signal.throwIfAborted();
      const response = await (options.request ?? requestPinned)(
        url,
        method,
        headers,
        bytes,
        addresses,
        deadline.signal,
      );
      if (
        ![301, 302, 303, 307, 308].includes(response.status) ||
        !response.headers.has("location")
      )
        return response;
      await response.body?.cancel();
      if (redirect === 3) throw new Error("Too many outbound redirects");
      const next = new URL(response.headers.get("location")!, url);
      if (next.origin !== url.origin)
        headers = headersFor({ accept: headers.get("accept") ?? "*/*" });
      if (
        (response.status === 303 && method !== "HEAD") ||
        ([301, 302].includes(response.status) && method === "POST")
      ) {
        method = "GET";
        bytes = Buffer.alloc(0);
        headers.delete("content-type");
      }
      url = next;
    }
    throw new Error("Too many outbound redirects");
  };
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        deadline.signal.addEventListener(
          "abort",
          () => reject(deadline.signal.reason),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
