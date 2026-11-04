# Now platform

This package implements the shared publishing backend. It is opt-in through
`homelab.infra.now.enable` and is enabled on Picard. The user interface for agents
is the existing lab MCP server’s `now_*` tools. The operational runbook is
`../homelab/docs/now.md` in the sibling Homelab checkout.

`src/control.ts` keeps app ownership, immutable source revisions, asynchronous
builds, releases, operation receipts and request logs in SQLite. Mutations need
an operation key. Repeating identical input recovers its recorded result; an
interrupted pending operation is reported as uncertain rather than repeated.
Source edits compare `baseRevision`; activation compares `expectedRelease`.

Apps have a one- or two-word `displayName` (up to 60 characters), separate from
their immutable ID and generated hostname. Creation requires this name and a
one-sentence description. The grid uses the display name; discovery matches it,
the description and the hostname. `now_rename` compares `expectedDisplayName`
before updating the name without changing code, releases, icons or user data.
The registry adds a nullable display-name column to older databases on startup;
legacy entries fall back to a humanised hostname until explicitly named.

Apps export a Durable Object class `App` from `src/app.ts`. Files under `public/`
are served as authenticated static assets. Dependencies use exact npm versions.
The server creates its own package manifest and disables lifecycle scripts.
Dependency installation and compilation use separate Landlock subprocesses;
neither can read service credentials or other app state. Compilation has no
useful network access. Uploaded code runs only inside celld's dynamic isolate.

The celld bootstrap authenticates control-plane envelopes, then routes to one
supervisor per immutable app ID and verified user identity. Each supervisor
owns an `app` facet. A release change aborts the facet and recreates its class
while retaining its database. Uploaded code receives no platform bindings,
credentials or direct outbound network capability. Server fetches use a trusted
`globalOutbound` entrypoint and a loopback-only authenticated broker.
`network.server` in each immutable source revision declares up to 16 exact HTTPS
origins. The broker checks every redirect, rejects all private/reserved DNS
answers and pins the checked address for TLS. It strips browser/platform identity
headers, limits calls to ten seconds, 1 MiB request bodies, 2 MiB responses and
three redirects, and allows two concurrent calls and 60 calls/minute per app
(eight concurrent globally). Raw sockets and server WebSockets remain blocked.
A root `now.json` with `{"permissions":{"inference":true}}` grants access to
GET `/v1/models`, POST `/v1/chat/completions` and POST `/v1/systemone` on
`https://ai.internal.leolab.party`. The broker routes only these calls to its
configured gateway backend, discards app-supplied headers and retains no gateway
credentials. Calls have a 60-second deadline, 1 MiB input and 2 MiB output, share
the outbound budgets and reject streaming and redirects. Permissions follow the
serving revision, including rollback; missing/false inference denies access.
Other server destinations still require `network.server` and public DNS.
Browser pages can use external HTTPS resources and fetch APIs under normal
CORS rules; framing, base URL and form restrictions remain. Requests always receive the stable
`X-Now-User-ID` derived from the configured issuer and authenticated OIDC subject.
Deploying or rolling back code does not roll back user data.

Browser ingress is a private Unix socket accessible to Caddy. Caddy removes the
incoming subject header and sets it from OAuth2 Proxy's verified subject.
The frontend rejects missing identity and cross-origin writes. Lab MCP uses a
separate service-authenticated request bridge with its verified caller subject;
MCP tokens are never treated as browser cookies.

Destroy first withdraws routing, cancels complete builder process groups, then
deletes each tracked user/probe facet, live source/releases and cached app
responses. Receipt hashes remain to prevent replay. Retired supervisor roots
retain a small tombstone, so old code cannot reopen them. Generated hostnames are never reused. Existing backups
expire normally; destroy is not secure erasure.

The Nix module uses native `/var/lib` storage for SQLite, celld and SeaweedFS,
with separate credentials loaded by systemd. The backup job briefly stops the
control plane, runtime and store to take a coherent private staging copy, then
resumes them before restic uploads it. Build scratch and celld's reconstructible
local cache are excluded from that snapshot.
Build scratch uses a private 256 MiB tmpfs. The initial platform limits are
24 live apps globally and 40 source revisions/releases per app.

`npm test` exercises control-plane ownership, source conflicts, deletion races,
operation recovery, import boundaries and authenticated ingress. The Linux
`checks.x86_64-linux.now-runtime` check runs actual celld/SeaweedFS with the
production compile sandbox, independent users/apps, updates, rollback, egress
denial, idle eviction, abrupt restart and a cold registry/store restore.
