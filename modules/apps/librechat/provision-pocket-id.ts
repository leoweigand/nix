import { execFileSync } from "node:child_process";

const key = execFileSync(
  "op",
  [
    ...(process.env.OP_SERVICE_ACCOUNT_TOKEN
      ? []
      : ["--account", "my.1password.eu"]),
    "read",
    "op://Homelab/Pocket ID API Key/credential",
  ],
  { encoding: "utf8" },
).trim();
const issuer = "https://auth.leolab.party";
const resource = "https://mcp.leolab.party/mcp";
async function api(path: string, method = "GET", body?: unknown) {
  const response = await fetch(`${issuer}/api${path}`, {
    method,
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`Pocket ID ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}
const clientId = "leolab-librechat";
const clients = await api("/oidc/clients?pagination%5Blimit%5D=100");
const existing = clients.data.find((c: { id: string }) => c.id === clientId);
if (existing && (existing.name !== "LibreChat" || !existing.isPublic))
  throw new Error(
    "LibreChat client ID already has a different owner/configuration",
  );
const settings = {
  name: "LibreChat",
  description: "Private lab chat sign-in",
  isPublic: true,
  pkceEnabled: true,
  isGroupRestricted: true,
  skipConsent: false,
  callbackURLs: ["https://chat.leolab.party/oauth/openid/callback"],
  logoutCallbackURLs: [],
  accessTokenDurationMinutes: 10,
  refreshTokenDurationMinutes: 43200,
};
await api(
  existing ? `/oidc/clients/${clientId}` : "/oidc/clients",
  existing ? "PUT" : "POST",
  existing ? settings : { id: clientId, ...settings },
);
const groups = await api("/user-groups?pagination%5Blimit%5D=100");
const admins = groups.data.find((g: { name: string }) => g.name === "admins");
if (!admins) throw new Error("Missing admins group");
await api(`/oidc/clients/${clientId}/allowed-user-groups`, "PUT", {
  userGroupIds: [admins.id],
});
console.log(JSON.stringify({ clientId, callback: settings.callbackURLs[0] }));
