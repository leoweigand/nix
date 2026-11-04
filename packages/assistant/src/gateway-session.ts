export const gatewayCookieName = "__Secure-leolab_gateway";
export const embeddedCookieName = "__Secure-now_embed";

export function embeddedCookie(cookie: string) {
  return (
    cookie
      .replace(/;\s*SameSite=[^;]*/gi, "")
      .replace(/;\s*Partitioned/gi, "") + "; SameSite=None; Partitioned"
  );
}

// Complete the existing OAuth exchange without loading identity-provider pages
// in a third-party iframe. Each origin receives only its own temporary cookies.
export async function gatewaySession(options: {
  issuer: string;
  loginUrl: string;
  target: string;
  subject: string;
  pocketCookies: string[];
  fetch: typeof fetch;
}) {
  const login = new URL(options.loginUrl).origin;
  const jars = new Map<string, Map<string, string>>([
    [
      options.issuer,
      new Map(
        options.pocketCookies.map((c) => {
          const pair = c.split(";")[0];
          return [pair.slice(0, pair.indexOf("=")), pair];
        }),
      ),
    ],
    [login, new Map()],
  ]);
  const sessionCookies = new Map<string, string>();
  const request = async (url: URL) => {
    const jar = jars.get(url.origin)!;
    const response = await options.fetch(url, {
      redirect: "manual",
      headers: { cookie: [...jar.values()].join("; ") },
      signal: AbortSignal.timeout(10000),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0];
      const name = pair.slice(0, pair.indexOf("="));
      const removed =
        /;\s*Max-Age=0(?:;|$)/i.test(cookie) || pair === `${name}=`;
      if (removed) jar.delete(name);
      else jar.set(name, pair);
      if (
        url.origin === login &&
        (name === gatewayCookieName ||
          /^__Secure-leolab_gateway_\d+$/.test(name))
      ) {
        if (removed) sessionCookies.delete(name);
        else sessionCookies.set(name, embeddedCookie(cookie));
      }
    }
    return response;
  };
  let url = new URL("/oauth2/start", login);
  url.searchParams.set("rd", options.target);
  for (let step = 0; step < 5; step++) {
    const allowed =
      (url.origin === login &&
        ["/oauth2/start", "/oauth2/callback"].includes(url.pathname)) ||
      (url.origin === options.issuer && url.pathname === "/authorize");
    if (!allowed || url.username || url.password)
      throw new Error("Unexpected sign-in redirect");
    const response = await request(url);
    await response.arrayBuffer();
    if (
      ![302, 303, 307].includes(response.status) ||
      !response.headers.has("location")
    )
      throw new Error(
        "Complete Pocket ID browser sign-in to Now once, then reopen Apps.",
      );
    const next = new URL(response.headers.get("location")!, url);
    if (next.href === options.target) {
      if (!sessionCookies.size)
        throw new Error("Gateway did not establish a session");
      const verified = await request(new URL("/oauth2/auth", login));
      await verified.arrayBuffer();
      if (
        !verified.ok ||
        verified.headers.get("x-auth-request-user") !== options.subject
      )
        throw new Error("Gateway identity mismatch");
      return [...sessionCookies.values()];
    }
    url = next;
  }
  throw new Error("Sign-in exceeded its redirect limit");
}
