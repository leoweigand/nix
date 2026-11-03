# Now platform candidate

This package implements the shared publishing backend. It is opt-in through
`homelab.infra.now.enable`; it is not enabled on Picard yet. The user interface
for agents is the existing lab MCP server's `now_*` tools.

`src/control.ts` keeps app ownership, immutable source revisions, asynchronous
builds, releases, operation receipts and request logs in SQLite. Mutations need
an operation key. Repeating identical input recovers its recorded result; an
interrupted pending operation is reported as uncertain rather than repeated.
Source edits compare `baseRevision`; activation compares `expectedRelease`.

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
credentials or outbound network capability. Requests always receive the stable
`X-Now-User-ID` derived from the configured issuer and authenticated OIDC subject.
Deploying or rolling back code does not roll back user data.

Browser ingress is a private Unix socket accessible to Caddy. Caddy removes the
incoming subject header and sets it from OAuth2 Proxy's verified subject.
The frontend rejects missing identity and cross-origin writes. Lab MCP uses a
separate service-authenticated request bridge with its verified caller subject;
MCP tokens are never treated as browser cookies.

Destroy first withdraws routing, then deletes each tracked user/probe facet and
live source/releases. Retired supervisor roots retain a small tombstone, so old
code cannot reopen them. Generated hostnames are never reused. Existing backups
expire normally; destroy is not secure erasure.

The Nix module uses native `/var/lib` storage for SQLite, celld and SeaweedFS,
with separate credentials loaded by systemd. The backup job briefly stops the
control plane, runtime and store to take a coherent private staging copy, then
resumes them before restic uploads it. Build scratch and celld's reconstructible
local cache are excluded from that snapshot.

`npm test` exercises control-plane ownership, source conflicts, deletion races,
operation recovery, import boundaries and authenticated ingress. The Linux
`checks.x86_64-linux.now-runtime` check runs actual celld/SeaweedFS with the
production compile sandbox, independent users/apps, updates, rollback, egress
denial, idle eviction, abrupt restart and a cold registry/store restore.
