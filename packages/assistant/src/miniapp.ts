import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJwt } from "jose";
import type { Connections } from "./connections.ts";

export const miniAppPath = "/now/telegram";
interface Options {
  issuer: string;
  libraryUrl: string;
  loginUrl: string;
  botToken: string;
  apiKey: string;
  ownerId: string;
  subject: string;
  allowedGroups: string[];
  stateDir: string;
  connections: Pick<Connections, "token">;
  fetch?: typeof fetch;
  now?: () => number;
}
const cookieName = "__Secure-now_launch";
const maxAge = 300;
const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

// Only the trusted launcher sees the Telegram bridge. Generated apps receive
// the ordinary gateway session and remain unaware of how it was established.
export class MiniApp {
  options: Options;
  fetch: typeof fetch;
  now: () => number;
  constructor(options: Options) {
    this.options = options;
    this.fetch = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    mkdirSync(join(options.stateDir, "miniapp-replays"), {
      recursive: true,
      mode: 0o700,
    });
  }
  private mac(value: string) {
    return createHmac("sha256", this.options.botToken)
      .update(value)
      .digest("hex");
  }
  private target(app: unknown) {
    const library = new URL(this.options.libraryUrl);
    if (!app) return library.href;
    if (typeof app !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(app))
      throw new Error("Invalid app");
    return `https://${app}.${library.hostname}/`;
  }
  private async pocket(path: string, init?: RequestInit) {
    const response = await this.fetch(`${this.options.issuer}/api${path}`, {
      ...init,
      headers: {
        "X-API-KEY": this.options.apiKey,
        "Content-Type": "application/json",
        ...init?.headers,
      },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Pocket ID refused sign-in");
    return response;
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const nonce = randomBytes(24).toString("base64url");
    const headers = new Headers({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}' https://telegram.org; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors https://web.telegram.org https://*.web.telegram.org; base-uri 'none'; form-action 'none'`,
    });
    if (url.pathname === miniAppPath && request.method === "GET") {
      const challenge = `${Math.floor(this.now() / 1000)}.${randomBytes(24).toString("hex")}`;
      headers.set(
        "set-cookie",
        `${cookieName}=${challenge}.${this.mac(challenge)}; Path=${miniAppPath}; Secure; HttpOnly; SameSite=None; Max-Age=${maxAge}`,
      );
      headers.set("content-type", "text/html; charset=utf-8");
      return new Response(
        `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Now</title>
<style nonce="${nonce}">:root{font-family:system-ui,sans-serif;color-scheme:light dark}body{max-width:32rem;margin:12vh auto;padding:1.5rem;line-height:1.5}a{color:inherit}p{overflow-wrap:anywhere}</style>
<h1>Now</h1><p id="status">Signing you in…</p><p><a href="${this.options.libraryUrl}">Open in your browser</a></p>
<script src="https://telegram.org/js/telegram-web-app.js"></script><script nonce="${nonce}">
(async()=>{const status=document.getElementById('status');try{
const data=window.Telegram?.WebApp?.initData;if(!data){status.textContent='Open Apps from Purrmeister’s menu, or use the browser link below.';return;}
const response=await fetch('${miniAppPath}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:data,app:new URL(location.href).searchParams.get('app')})});
const result=await response.json();if(!response.ok)throw new Error(result.message);location.replace(result.redirect);
}catch(error){status.textContent=error.message||'Sign-in failed. Close this window and try again.';}})();</script></html>`,
        { headers },
      );
    }
    if (url.pathname !== miniAppPath || request.method !== "POST")
      return new Response(null, { status: 404, headers });
    headers.set("content-type", "application/json");
    try {
      if (request.headers.get("origin") !== this.options.issuer)
        throw new Error("Invalid launch origin");
      const cookie =
        request.headers
          .get("cookie")
          ?.split(";")
          .map((v) => v.trim())
          .find((v) => v.startsWith(`${cookieName}=`))
          ?.slice(cookieName.length + 1) ?? "";
      const [issued, random, signature] = cookie.split(".");
      const age = Math.floor(this.now() / 1000) - Number(issued);
      if (
        !/^\d+$/.test(issued ?? "") ||
        !/^[a-f0-9]{48}$/.test(random ?? "") ||
        !equal(signature ?? "", this.mac(`${issued}.${random}`)) ||
        age < 0 ||
        age > maxAge
      )
        throw new Error("Launch expired. Close this window and open it again.");
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      for await (const chunk of request.body ?? []) {
        bytes += chunk.byteLength;
        if (bytes > 16384) throw new Error("Launch data too large");
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (typeof input.initData !== "string")
        throw new Error("Missing launch data");
      const data = new URLSearchParams(input.initData);
      if ([...data.keys()].length !== new Set(data.keys()).size)
        throw new Error("Duplicate launch fields");
      const hash = data.get("hash") ?? "";
      data.delete("hash");
      const secret = createHmac("sha256", "WebAppData")
        .update(this.options.botToken)
        .digest();
      const expected = createHmac("sha256", secret)
        .update(
          [...data.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${k}=${v}`)
            .join("\n"),
        )
        .digest("hex");
      if (!/^[a-f0-9]{64}$/.test(hash) || !equal(hash, expected))
        throw new Error("Invalid Telegram signature");
      const authDate = Number(data.get("auth_date"));
      const launchAge = Math.floor(this.now() / 1000) - authDate;
      if (
        !Number.isSafeInteger(authDate) ||
        launchAge < -30 ||
        launchAge > maxAge
      )
        throw new Error("Telegram launch expired");
      const user = JSON.parse(data.get("user") ?? "null");
      if (String(user?.id) !== this.options.ownerId)
        throw new Error("This Telegram account is not authorised");
      const target = this.target(data.get("start_param") || input.app);
      const accessToken = await this.options.connections.token(
        this.options.ownerId,
      );
      if (
        !accessToken ||
        !String(decodeJwt(accessToken).scope ?? "")
          .split(" ")
          .includes("now:read")
      )
        throw new Error(
          "Send /connect to Purrmeister in your private chat first.",
        );
      const userResponse = await this.pocket(
        `/users/${encodeURIComponent(this.options.subject)}`,
      );
      const pocketUser = await userResponse.json();
      const groups = await (
        await this.pocket(
          `/users/${encodeURIComponent(this.options.subject)}/groups`,
        )
      ).json();
      if (
        pocketUser.id !== this.options.subject ||
        pocketUser.disabled ||
        !Array.isArray(groups) ||
        !groups.some((g: { name: string }) =>
          this.options.allowedGroups.includes(g.name),
        )
      )
        throw new Error("Pocket ID account is not authorised");
      // Persist before minting: a restart or ambiguous upstream failure must not
      // turn the same Telegram proof into another Pocket ID login.
      const directory = join(this.options.stateDir, "miniapp-replays");
      for (const name of readdirSync(directory)) {
        if (
          /^\d+-[a-f0-9]{64}$/.test(name) &&
          Number(name.split("-")[0]) <
            Math.floor(this.now() / 1000) - maxAge - 30
        )
          unlinkSync(join(directory, name));
      }
      const replay = `${authDate}-${createHash("sha256").update(hash).digest("hex")}`;
      try {
        writeFileSync(join(directory, replay), "", { flag: "wx", mode: 0o600 });
      } catch {
        throw new Error(
          "This launch was already used. Close this window and open it again.",
        );
      }
      const minted = await (
        await this.pocket(
          `/users/${encodeURIComponent(this.options.subject)}/one-time-access-token`,
          { method: "POST", body: JSON.stringify({ ttl: "60s" }) },
        )
      ).json();
      if (
        typeof minted.token !== "string" ||
        !/^[A-Za-z0-9]{6,12}$/.test(minted.token)
      )
        throw new Error("Pocket ID returned an invalid login token");
      // Redeem server-side; only Pocket ID's genuine cookies reach the browser.
      // Never return the administrative key or the one-time token to JavaScript.
      const exchanged = await this.pocket(
        `/one-time-access-token/${minted.token}`,
        {
          method: "POST",
          headers: {
            "User-Agent": request.headers.get("user-agent") ?? "Now launcher",
          },
        },
      );
      if ((await exchanged.json()).id !== this.options.subject)
        throw new Error("Pocket ID identity mismatch");
      const cookies = exchanged.headers.getSetCookie();
      if (!cookies.length)
        throw new Error("Pocket ID did not establish a session");
      for (const value of cookies) headers.append("set-cookie", value);
      headers.append(
        "set-cookie",
        `${cookieName}=; Path=${miniAppPath}; Secure; HttpOnly; SameSite=None; Max-Age=0`,
      );
      const redirect = new URL("/oauth2/start", this.options.loginUrl);
      redirect.searchParams.set("rd", target);
      return new Response(JSON.stringify({ redirect: redirect.href }), {
        headers,
      });
    } catch (error) {
      // Upstream errors and credentials never enter agent context or logs.
      return new Response(
        JSON.stringify({
          message: error instanceof Error ? error.message : "Sign-in failed",
        }),
        { status: 403, headers },
      );
    }
  }
}
