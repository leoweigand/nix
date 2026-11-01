import { createRemoteJWKSet, jwtVerify } from "jose";
import type { AuthInfo } from "@modelcontextprotocol/server";

export function createVerifier(
  issuer: string,
  resource: string,
  jwksUrl: string,
) {
  const keys = createRemoteJWKSet(new URL(jwksUrl), { timeoutDuration: 3000 });
  return async (token: string): Promise<AuthInfo> => {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: resource,
      algorithms: ["RS256"],
      typ: "at+jwt",
      requiredClaims: ["sub", "client_id", "exp", "iat", "jti"],
    });
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.client_id !== "string" ||
      !payload.client_id ||
      (payload.scope !== undefined && typeof payload.scope !== "string")
    ) {
      throw new Error("Invalid access token claims");
    }
    return {
      token,
      clientId: payload.client_id,
      scopes:
        typeof payload.scope === "string"
          ? payload.scope.split(" ").filter(Boolean)
          : [],
      expiresAt: payload.exp,
      resource: new URL(resource),
      extra: { subject: payload.sub, issuer },
    };
  };
}
