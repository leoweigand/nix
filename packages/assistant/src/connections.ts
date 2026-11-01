import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import {
  authorizeMcp,
  McpOAuthProvider,
  OAuthError,
  type McpOAuthState,
} from "@earendil-works/pi-mcp/oauth";
import { authorized } from "./inbox.ts";
import { readJson, writeJson } from "./storage.ts";

export const issuer = "https://auth.leolab.party";
export const resource = "https://mcp.leolab.party/mcp";
export const clientId = "leolab-mcp-telegram";
export const scopes = "openid offline_access lab:read media:read media:request";
export const callbackPath = "/assistant/oauth/callback";
const permissionScopes = ["lab:read", "media:read", "media:request"];
interface Pending {
  telegramId: string;
  expiresAt: number;
  authorizationUrl?: string;
  oauth: McpOAuthState;
}
interface Connection {
  telegramId: string;
  subject: string;
  oauth: McpOAuthState;
}
interface Options {
  stateDir: string;
  telegramId: string;
  subject: string;
  callbackUrl: string;
  fetch?: typeof fetch;
  keys?: JWTVerifyGetKey;
  now?: () => number;
}
export class ConnectionRequired extends Error {}

// One allowlisted Telegram/Pocket ID binding; the storage is already keyed by sender.
export class Connections {
  options: Options;
  directory: string;
  keys: JWTVerifyGetKey;
  now: () => number;
  private operation: Promise<unknown> = Promise.resolve();
  constructor(options: Options) {
    if (
      !/^\d+$/.test(options.telegramId) ||
      !options.subject ||
      new URL(options.callbackUrl).protocol !== "https:"
    )
      throw new Error("Invalid assistant identity configuration");
    this.options = options;
    this.directory = join(options.stateDir, "connections", options.telegramId);
    this.keys =
      options.keys ??
      createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
        timeoutDuration: 5000,
      });
    this.now = options.now ?? Date.now;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.operation.then(fn, fn);
    this.operation = next.catch(() => {});
    return next;
  }
  private checkSender(telegramId: string) {
    if (telegramId !== this.options.telegramId)
      throw new Error("Telegram identity is not allowed");
  }
  private async verify(oauth: McpOAuthState): Promise<void> {
    if (!oauth.tokens?.access_token || !oauth.tokens.refresh_token)
      throw new ConnectionRequired("Missing refreshable MCP grant");
    const { payload } = await jwtVerify(oauth.tokens.access_token, this.keys, {
      issuer,
      audience: resource,
      algorithms: ["RS256"],
      typ: "at+jwt",
      requiredClaims: ["sub", "client_id", "exp", "iat"],
      currentDate: new Date(this.now()),
    });
    if (
      payload.sub !== this.options.subject ||
      payload.client_id !== clientId ||
      typeof payload.scope !== "string" ||
      !permissionScopes.every((scope) =>
        payload.scope!.toString().split(" ").includes(scope),
      )
    )
      throw new ConnectionRequired(
        "Pocket ID identity or permissions do not match the configured owner",
      );
  }
  private provider(
    load: () => McpOAuthState,
    save: (state: McpOAuthState) => void,
    onRedirect: (url: URL) => void,
  ) {
    return new McpOAuthProvider({
      serverUrl: resource,
      redirectUrl: this.options.callbackUrl,
      clientId,
      clientMetadata: { client_name: "LeoLab Telegram Assistant" },
      store: { load, save },
      onRedirect,
    });
  }
  private flow() {
    return {
      serverUrl: resource,
      scope: scopes,
      authorizationServerMetadataUrl: new URL(
        `${issuer}/.well-known/openid-configuration`,
      ),
      fetch:
        this.options.fetch ??
        ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );
          if (![issuer, new URL(resource).origin].includes(url.origin))
            throw new Error(
              "OAuth endpoint is outside the configured lab services",
            );
          return fetch(input, { ...init, redirect: "error" });
        }),
      signal: AbortSignal.timeout(15000),
    };
  }
  async begin(telegramId: string): Promise<string> {
    this.checkSender(telegramId);
    return this.serial(async () => {
      const path = join(this.directory, "pending.json");
      const old = readJson<Pending>(path);
      if (old && old.expiresAt > this.now() && old.authorizationUrl)
        return old.authorizationUrl;
      const pending: Pending = {
        telegramId,
        expiresAt: this.now() + 10 * 60_000,
        oauth: { serverUrl: resource },
      };
      const save = () => writeJson(path, pending);
      const provider = this.provider(
        () => pending.oauth,
        (state) => {
          pending.oauth = state;
          save();
        },
        (url) => {
          pending.authorizationUrl = url.href;
          save();
        },
      );
      const result = await authorizeMcp(provider, {
        ...this.flow(),
        skipRefresh: true,
      });
      if (result !== "REDIRECT" || !pending.authorizationUrl)
        throw new Error("OAuth did not produce a sign-in link");
      return pending.authorizationUrl;
    });
  }
  async complete(url: URL): Promise<void> {
    return this.serial(async () => {
      const path = join(this.directory, "pending.json");
      const pending = readJson<Pending>(path);
      if (
        !pending ||
        pending.telegramId !== this.options.telegramId ||
        pending.expiresAt <= this.now() ||
        !authorized(
          url.searchParams.get("state"),
          pending.oauth.oauthState ?? "",
        )
      )
        throw new ConnectionRequired(
          "This sign-in link is invalid or expired. Send /connect to the bot for a new link.",
        );
      // Consume before exchanging the one-time code, including denied/failed callbacks.
      unlinkSync(path);
      if (
        url.searchParams.has("error") ||
        url.searchParams.get("iss") !== issuer ||
        !url.searchParams.get("code")
      )
        throw new ConnectionRequired(
          "Sign-in was declined or came from a different issuer. Send /connect to try again.",
        );
      const provider = this.provider(
        () => pending.oauth,
        (state) => {
          pending.oauth = state;
        },
        () => {
          throw new ConnectionRequired("Authorization did not complete");
        },
      );
      const result = await authorizeMcp(provider, {
        ...this.flow(),
        authorizationCode: url.searchParams.get("code")!,
        iss: issuer,
      });
      if (result !== "AUTHORIZED")
        throw new ConnectionRequired("Authorization did not complete");
      await this.verify(pending.oauth);
      delete pending.oauth.codeVerifier;
      delete pending.oauth.oauthState;
      writeJson(join(this.directory, "connection.json"), {
        telegramId: this.options.telegramId,
        subject: this.options.subject,
        oauth: pending.oauth,
      } satisfies Connection);
    });
  }
  async token(telegramId: string): Promise<string | undefined> {
    this.checkSender(telegramId);
    return this.serial(async () => {
      const path = join(this.directory, "connection.json");
      const connection = readJson<Connection>(path);
      if (!connection) return undefined;
      if (
        connection.telegramId !== telegramId ||
        connection.subject !== this.options.subject
      )
        throw new Error(
          "Stored MCP identity does not match its Telegram owner",
        );
      if ((connection.oauth.tokensExpireAt ?? 0) - this.now() < 180000) {
        const provider = this.provider(
          () => connection.oauth,
          (state) => {
            connection.oauth = state;
            writeJson(path, connection);
          },
          () => {
            throw new ConnectionRequired("Sign in again");
          },
        );
        try {
          await authorizeMcp(provider, this.flow());
        } catch (error) {
          if (
            error instanceof ConnectionRequired ||
            (error instanceof OAuthError &&
              ["invalid_grant", "invalid_token", "access_denied"].includes(
                error.code,
              ))
          ) {
            unlinkSync(path);
            return undefined;
          }
          throw error;
        }
      }
      try {
        await this.verify(connection.oauth);
      } catch (error) {
        if (
          error instanceof ConnectionRequired ||
          (error instanceof Error &&
            ["JWTExpired", "JWTClaimValidationFailed"].includes(error.name))
        ) {
          unlinkSync(path);
          return undefined;
        }
        throw error;
      }
      return connection.oauth.tokens?.access_token;
    });
  }
}
