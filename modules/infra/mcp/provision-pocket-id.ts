import { execFileSync } from "node:child_process";

// Run explicitly as the lab administrator; credentials never enter server config.
const assistant = process.argv.includes("--assistant");
const clientName = assistant
  ? "LeoLab MCP — Telegram Assistant"
  : "LeoLab MCP — Codex";
const callback = assistant
  ? "https://webhooks.leolab.party/assistant/oauth/callback"
  : "http://127.0.0.1:47831/callback";
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
const apis = await api("/apis?pagination%5Blimit%5D=100");
let entry = apis.data.find(
  (item: { resource: string }) => item.resource === resource,
);
if (!entry)
  entry = await api("/apis", "POST", { name: "LeoLab MCP", resource });
if (entry.name !== "LeoLab MCP")
  throw new Error("Resource exists with a different owner name");
const permissions = [
  {
    key: "home:read",
    name: "Read home devices",
    description:
      "Read approved Home Assistant devices and their current states",
  },
  {
    key: "home:control",
    name: "Control home devices",
    description: "Operate approved Home Assistant lights and blinds",
  },
  {
    key: "lab:read",
    name: "Inspect caller identity",
    description: "Read the authenticated caller identity",
  },
  {
    key: "media:read",
    name: "Search and inspect media",
    description: "Search movies and TV shows and inspect library status",
  },
  {
    key: "media:request",
    name: "Request media",
    description:
      "Add movies and aired TV episodes, monitor them and start download searches",
  },
];
entry = await api(`/apis/${entry.id}/permissions`, "PUT", {
  permissions: [
    ...entry.permissions
      .filter(
        (p: { key: string }) =>
          !permissions.some((permission) => permission.key === p.key),
      )
      .map((p: { key: string; name: string; description?: string }) => ({
        key: p.key,
        name: p.name,
        description: p.description ?? null,
      })),
    ...permissions,
  ],
});
const permissionIds = entry.permissions
  .filter((p: { key: string }) =>
    permissions.some((permission) => permission.key === p.key),
  )
  .map((p: { id: string }) => p.id);
const clientId = assistant ? "leolab-mcp-telegram" : "leolab-mcp-codex";
const clients = await api("/oidc/clients?pagination%5Blimit%5D=100");
const existing = clients.data.find(
  (item: { id: string }) => item.id === clientId,
);
if (!existing) {
  await api("/oidc/clients", "POST", {
    id: clientId,
    name: clientName,
    description: assistant
      ? "User-bound media and Home Assistant tools through the Telegram assistant"
      : "Codex desktop and CLI access to private LeoLab tools",
    isPublic: true,
    pkceEnabled: true,
    isGroupRestricted: true,
    skipConsent: false,
    callbackURLs: [callback],
    logoutCallbackURLs: [],
    accessTokenDurationMinutes: 10,
    refreshTokenDurationMinutes: 43200,
  });
} else if (!existing.isPublic || existing.name !== clientName) {
  throw new Error(
    "Client ID already has a different configuration; inspect it manually",
  );
}
if (assistant && existing) {
  await api(`/oidc/clients/${clientId}`, "PUT", {
    name: clientName,
    description:
      "User-bound media and Home Assistant tools through the Telegram assistant",
    isPublic: true,
    pkceEnabled: true,
    isGroupRestricted: true,
    skipConsent: false,
    callbackURLs: [callback],
    logoutCallbackURLs: [],
    accessTokenDurationMinutes: 10,
    refreshTokenDurationMinutes: 43200,
  });
}
const groups = await api("/user-groups?pagination%5Blimit%5D=100");
const admins = groups.data.find(
  (group: { name: string }) => group.name === "admins",
);
if (!admins) throw new Error("Missing admins group");
await api(`/oidc/clients/${clientId}/allowed-user-groups`, "PUT", {
  userGroupIds: [admins.id],
});
await api(`/apis/${entry.id}/clients/${clientId}`, "PUT", {
  userDelegatedAccess: true,
  clientAccess: false,
  userDelegatedPermissionIds: permissionIds,
  clientPermissionIds: [],
});
console.log(
  JSON.stringify({
    resource,
    apiId: entry.id,
    clientId,
    permissions: permissions.map((p) => p.key),
    callback,
  }),
);
