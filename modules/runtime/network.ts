/** Keep redirects within the same approved origins as the initial request. */
export function restrictedFetch(
  origins: readonly string[],
  transport: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const allowed = new Set(origins);
  return async (input, init) => {
    let request = new Request(input, init);
    const redirect = request.redirect;
    for (let count = 0; ; count++) {
      if (!allowed.has(new URL(request.url).origin)) {
        throw new Error(
          "HTTP destination is outside this automation's network policy",
        );
      }
      const retry = request.clone();
      const response = await transport(request, { redirect: "manual" });
      const location = response.headers.get("location");
      if (
        ![301, 302, 303, 307, 308].includes(response.status) ||
        !location ||
        redirect === "manual"
      ) {
        return response;
      }
      await response.body?.cancel();
      if (redirect === "error" || count >= 20)
        throw new Error("HTTP redirect refused");
      const url = new URL(location, request.url);
      const headers = new Headers(retry.headers);
      if (url.origin !== new URL(request.url).origin) {
        headers.delete("authorization");
        headers.delete("cookie");
        headers.delete("proxy-authorization");
      }
      const toGet =
        ((response.status === 301 || response.status === 302) &&
          retry.method === "POST") ||
        (response.status === 303 &&
          retry.method !== "GET" &&
          retry.method !== "HEAD");
      if (toGet) {
        for (const header of [
          "content-type",
          "content-length",
          "content-encoding",
          "content-language",
          "content-location",
        ])
          headers.delete(header);
      }
      request = new Request(url, {
        method: toGet ? "GET" : retry.method,
        headers,
        signal: retry.signal,
        ...(toGet || !retry.body
          ? {}
          : { body: retry.body, duplex: "half" as const }),
      });
    }
  };
}
