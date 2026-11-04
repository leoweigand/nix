# Homelab infrastructure

NixOS configuration for my homelab.

## Key Features

- Remote access and SSH authentication through Tailscale
- Secret management using 1Password with [opnix](https://github.com/brizzbuzz/opnix)
- Backups of all critical data to Backblaze B2 using restic
- Edge reverse proxy on picard with Caddy and wildcard TLS via ACME DNS-01 (Cloudflare)
- Containerized and native services with persistent appdata on `/mnt/fast`

## Custom automation

Use TypeScript with Node 26 for custom automation. Native type stripping runs
our `.ts` sources directly; constructors use explicit fields rather than
TypeScript parameter properties. Prefer Node and Web built-ins; use Nix or
shell only for configuration and small glue.

`nix develop` supplies the pinned Node/npm toolchain. Run `npm ci`, `npm test`,
`npm run check` and `npm run format:check`; `npm run format` formats the sources.
Type checking is separate from execution. `package-lock.json` pins dependencies,
including the JSR packages accessed through their npm compatibility registry.
`packages/automation/default.nix` verifies the source and installs production
dependencies in the Nix store; services do not install packages at runtime.

Picard's launchers apply a strict Landlock filesystem and TCP-port policy and
pass only explicitly declared environment variables. Filesystem restrictions
cover SQLite and child processes, while atomic Cloudflare state writes retain
`fsync`. The sandbox requires a Landlock ABI 6+ kernel and fails closed if it
cannot apply the policy. HTTP origin checks also apply to redirects; these are
application checks, while Landlock limits ports rather than remote hostnames.
Existing systemd hardening remains in place. The scripts cover notification
submission, Cloudflare publication, seedbox cleanup, Paperless titles and
Sonarr/Radarr import notifications.

`nix build .#checks.x86_64-linux.automation` runs all TypeScript checks and tests;
`nix build .#checks.x86_64-linux.automation-sandbox` verifies filesystem/SQLite
isolation, atomic writes and TCP denial on Linux.

## MCP tools

`homelab.infra.mcp` runs private MCP tools at `https://mcp.leolab.party/mcp`.
Pocket ID authenticates every request. `media:read` grants catalog search and
media details; `media:request` grants acquisition requests. The Codex client
requires PKCE and the `admins` group. `lab:read` remains for identity diagnostics. `home:read` and `home:control` separately
grant approved Home Assistant entity reads and runtime controls.

`modules/infra/mcp/` provides `whoami`, `search_media`, `get_media_details`,
`get_download_progress` and `request_media`, plus `search_home_entities`, `get_home_entity` and
`control_home_entities`, using the official TypeScript MCP SDK v2. Media tools talk to
Sonarr and Radarr over fixed loopback APIs. HD is the default; other configured
profile names can be selected explicitly. TV requests monitor only aired
episodes in explicit seasons, with future monitoring disabled for new shows.
Existing quality profiles are preserved. Active shows retain monitoring outside
the selection. Disabled shows are enabled only after dormant monitoring flags
are cleared, so unrelated episodes and future seasons stay off.
These requests bypass Seerr's request history and approval workflow.

`get_download_progress` is an explicit-user-request-only read under `media:read`.
It takes an optional media ID or shows the current bounded movie/TV queues.
Results distinguish torrent download percentage from transfer to Picard: a local
Syncthing needed-files snapshot can confirm active or queued transfer for the
completed download's exact inbox path. Unknown transfer/import state stays
explicit; completed torrents and empty queues do not prove library availability.
MCP receives Syncthing's existing config as a systemd credential and reads only
its fixed local API; there is no seedbox connection, polling or media mount.

TV details include the next known scheduled episode (season, episode number,
optional title and UTC air time), including specials and unmonitored shows.
No known future air time returns null; this does not establish that a show has ended.

Search and details return public artwork URLs, release metadata, library facts
and permission-filtered `availableActions` containing complete tool arguments.
Every tool publishes an output schema from `modules/infra/mcp/contracts.ts`
or `modules/infra/mcp/home.ts`.
These are data contracts; assistants and clients own presentation and controls.

The existing locked Node automation package and Landlock launcher restrict file
access and TCP ports. Arr API keys come from systemd credential copies of their
existing XML configurations, never from the Nix store. No persistent request
database or media filesystem access is needed. The private Caddy route permits
LAN, Tailscale and loopback callers; the backend binds only to loopback. See the
[MCP runbook](../homelab/docs/mcp.md) for schemas, scope provisioning, limitations,
client setup and verification.

`homelab.infra.mcp.home` declares the readable HA inventory, room aliases and
per-entity writable actions. Picard exposes its nine lights and two blinds.
MCP uses a fixed loopback REST endpoint and an opnix/systemd token credential;
the assistant never receives that token. Controls validate the full target list,
serialize overlapping writes and report per-target HA read-back. Uncertain writes
are never automatically replayed. The assistant saves durable receipts for both
media and home writes and exposes only tools allowed by its current user grant.

Bookmark tools (`search_bookmarks`, `get_bookmark`, `save_bookmark`) use one global
Linkding API token through opnix/systemd credentials. `bookmarks:read` and
`bookmarks:write` are separate OAuth permissions; both also require the exact
`homelab.infra.mcp.bookmarks.ownerSubject`. Other subjects are rejected before
backend calls even when their token has those scopes. Pocket ID currently gates
whole clients by group, not individual API permissions by user. No per-user
credential mapping or default-account fallback exists. Results contain bookmark
metadata and notes, not article bodies. The Telegram assistant exposes these tools
only in private conversations and records durable receipts before saves.


`homelab.infra.mcp.documents.enable` adds Paperless search, bounded OCR text reads,
PDF/photo ingestion and ingestion status. Document operations require their
`documents:read` or `documents:ingest` scope plus current `admins` membership,
resolved from Pocket ID UserInfo using the caller's token and matching subject.
Clients must request `openid groups`; MCP needs no Pocket ID administrative key.
The Paperless token comes from `op://Homelab/MCP Server/LEO_PAPERLESS_TOKEN`
through opnix/systemd credentials. A separate authenticated `/attachments` upload
endpoint accepts at most 20 MiB and returns caller-bound opaque references.
Private staging expires after 24 hours; durable receipts prevent upload replay
across restarts. State lives in `/var/lib/private/leolab-mcp`, included in Picard's
appdata backup. Telegram receives PDFs/photos only in Leo's private DM and never
passes file bytes or Telegram credentials to the model. Deployed on Picard on
1 November 2026. Paperless calls pin API v9 so task status and document IDs retain
the validated response shape.

The Paperless title hook inherits its worker's systemd restrictions. Its two
worker units disable `MemoryDenyWriteExecute` only when title extraction is
enabled: Node's JIT, TypeScript loading and HTTP parser require executable memory.
Their Landlock, filesystem, syscall and process-visibility restrictions remain.
The shared launcher adds `/proc/meminfo` and `/proc/cpuinfo` read rules only when
those files exist, allowing workers with `ProcSubset=pid` to start the hook.

## Telegram assistant

With `homelab.infra.assistant.miniApp.enable`, the private Telegram Apps menu
opens Now through a trusted launcher on the Pocket ID hostname. The launcher
verifies the signed Telegram identity and existing account connection, checks
current Pocket ID access, then uses a short-lived one-time Pocket ID login and
the normal OAuth2 Proxy flow. The existing Pocket ID administrative API key is
loaded as a systemd credential; it is never exposed to generated apps or models.
The backend completes OAuth and verifies the gateway identity before issuing a
partitioned browser session, so Telegram Web never embeds Pocket ID pages. Now
permits framing by Telegram Web only and preserves the cookie partition during
renewal. The launcher consumes accepted proofs durably to prevent replay.

`https://now.leolab.party/` is the authenticated, mobile-first app library: a
compact grid of app names and stable coloured squiggle icons generated from app
IDs, headed Apps, with no search or description copy.
Private-chat buttons for canonical Now app URLs open the selected app inside
Telegram; group buttons remain browser links. The library and apps retain private
LAN/Tailscale reachability. Generated apps remain ordinary websites; general and
coding guidance requires simple mobile-first interfaces and system fonts, while
launch-button guidance belongs only to the Telegram channel.

`homelab.infra.assistant` runs Pi 1.4.0 as a separate worker behind the existing
notification gateway's Telegram webhook. It accepts Leo's DMs and explicit bot
mentions in configured groups, persists accepted jobs, and keeps Pi sessions
separate by chat/sender/topic. Replies preserve their original message and topic.
Telegram group privacy must allow mention delivery before group use is reliable.

`packages/assistant/` independently locks Pi and patched dependencies. The worker
uses Claude Haiku 5.5 through the AI gateway and the requesting sender's MCP
connection for media lookup/acquisition and approved Home Assistant controls. It has no coding tools. Ordinary
conversation works without OAuth; a request needing MCP triggers a private
Pocket ID sign-in link and resumes after authorization. `/connect` renews or
resends the link. The public callback is on Picard, so no Mac helper is required.

The worker also has an Exa Lite web search tool, available without MCP sign-in.
It sends queries to Exa, asks for up to five results with highlights, and limits
each message to three searches. Opnix loads the Exa API key from
`op://Homelab/MCP Server/EXA_API_KEY`; systemd passes it as a credential rather
than embedding it in the Nix store. Search usage is billed against Exa credits.

The dedicated Pocket ID public PKCE client has `lab:read`, `media:read` and
`media:request`, `home:read` and `home:control` delegated permissions. Its callback verifies the token's issuer,
audience, client ID, scopes and configured immutable owner subject before saving
the Telegram/Pocket ID binding. Only Leo's Telegram ID is allowed initially.
Provision the client with `node modules/infra/mcp/provision-pocket-id.ts --assistant`.
The package checks cover identity binding, PKCE/replay/expiry, rotating refresh
grants, persistent resumption, private routing and interrupted write handling.

The routing layer selects a native Pi session per DM or group/topic, starting
fresh after twenty conversation messages or ten minutes of inactivity, or on
`/clear`. Tool calls and controls do not consume this counter. Notifications enter
Pi history without invoking inference, quoted messages accompany requests, and
`/session` reports the current session, model and pinned instruction revision.
Core behavior is Markdown in `packages/assistant/instructions/SYSTEM.md`; the
selected presentation skill is `packages/assistant/skills/telegram/SKILL.md`.
After committing edits, `node packages/assistant/scripts/sync-instructions.ts`
updates the runtime bundle without a rebuild; new sessions load the new version.

Landlock and systemd restrict the worker to its state directory, read-only
instruction bundle and declared network ports. Its process never receives the Telegram bot token. The inbox,
private OAuth credentials and transcripts live under
`/mnt/fast/appdata/leolab-assistant`, covered by appdata backups. See the
[assistant runbook](../homelab/docs/telegram-assistant.md) for setup, grant renewal,
limitations and verification status.

## Experimental Eve assistant engine

`homelab.infra.assistant.runtime` defaults to `"pi"`. Setting it to `"eve"`
selects the packaged Eve 1.0.0-rc.2 candidate. The live runtime is not changed
merely by building the package. Remaining rollout checks are tracked in the
[migration plan](../homelab/plans/eve-assistant-migration.md).

Eve definitions live under `packages/assistant/agent/`: the root `agent.ts`
uses Haiku (`claude-haiku-5-5`); `subagents/coder/agent.ts` uses DeepSeek Flash
(`deepseek-v4.1-flash`). Both use the lab AI gateway. Eve provides native
subagent tasks and follow-up messaging. Both agents disable default tools and
use a provider that rejects filesystem and process operations. The coder has
its own instructions and no inherited lab connection; until Now tools exist,
it returns code inline.

The existing worker retains Telegram ingress, private sign-in, attachments,
notification context, presentation and write-recovery guards. In Eve mode it
supervises the built engine on loopback port 9091; ingress remains on port 9090.
The engine's default HTTP session API is disabled and its internal turn route
requires the worker secret. `agent/connections/leolab.ts` obtains the caller's
existing Pocket ID grant, filters by scopes and audience, and journals writes
before execution. Eve's runtime state lives on Picard's native filesystem at
`/var/lib/leolab-assistant-eve`, with workflows under `.eve/.workflow-data`.
Systemd creates the private directory; Landlock grants Eve access, and Picard's
appdata backup includes it even after switching back to Pi. Telegram inbox/grants
remain under `/mnt/fast/appdata/leolab-assistant`. The virtiofs share returns
`ESTALE` after hard-link staging files are unlinked, so it cannot hold Eve's local
world. Pi remains the ledger/OAuth compatibility dependency.
No separate Now MCP service is introduced.

The package build applies a version/hash-guarded local-world recovery patch before
compiling Eve. Terminal step and run transitions use durable redo records;
startup finishes interrupted commits before re-enqueuing work. The worker saves
and reuses each delivery ID so an interrupted request follows its original result.
The one-process engine disables dead invocation ownership leases for prompt
recovery. See the [patch notes](packages/assistant/patches/README.md) for the
implementation, exact scope and handling of old corrupted state.

For local development, run `npm ci` and `npm run build` in `packages/assistant`,
then `node --test src/*_test.ts`. The same build command applies the patch after
`npm ci --ignore-scripts`. Normal checks cover terminal persistence with SIGKILL,
repeated recovery, immediate restart after a reply, and interrupted root/coder
inference. Settled replies do not replay inference; unfinished inference may retry.
`EVE_LIVE_TEST=1 node --test src/eve-integration_test.ts` uses both real models with
synthetic prompts and sends no Telegram messages.

## Machines
- **picard (NixOS VM on laforge)**: Runs the homelab edge (reverse proxy, DNS), plus apps (Immich, Paperless-ngx, etc.). Laforge is the Unraid host with the storage array and SSD cache drives.
- **crusher (macOS)**: Includes `rainfrog` and `rainfrog-prod`. The latter connects
  to the production read-only PostgreSQL role, fetching its connection string from
  the Elephant 1Password account at launch and passing it through `DATABASE_URL`.

Picard also runs the upstream Rex login server, pinned through the `rex` snapshot
flake input. `machines/picard/rex.nix` allows only Leo's Tailscale login to use
the existing `leo` account at `http://picard.stargazer-octatonic.ts.net:7297`.
It uses the host's Tailscale addresses and PAM, leaving Caddy's HTTPS listener
available. Update with `nix flake update rex`; this release requires no download
token. Connection and operational details live in the
[Homelab Rex notes](../homelab/docs/rex.md).

## Darwin Package Policy

Darwin rebuilds should install third-party dependencies and applications from
binary artifacts, not compile them locally. Prefer, in order:

1. nixpkgs packages available from `cache.nixos.org`
2. upstream prebuilt binaries wrapped by Nix
3. Homebrew formulae or casks

Source builds are reserved for locally developed software and explicit
exceptions. Before adding an external flake package, verify that its complete
`aarch64-darwin` closure is available from a trusted binary cache. Run
`scripts/check-darwin-build-plan.sh <machine>` before a rebuild to surface
unexpected local compilation.

### Application ownership

Shared GUI apps live in `modules/darwin/common.nix`; Ro-only apps live in
`machines/ro/configuration.nix`. Casks use the upstream prebuilt apps. App Store
installs retain their existing distribution: Things is shared, while 1Password
for Safari, AdGuard Mini and Bitwarden are Ro-only.

Ro deliberately leaves its other apps, including Codex CLI, Ghostty and the iA
Writer Quattro font, manually managed. Its Homebrew activation installs and
upgrades declared apps without cleaning up undeclared packages. Crusher retains
its cask/formula cleanup in a separate `brew bundle cleanup --no-mas --zap --force`
pass. This excludes App Store apps, so adding Things does not remove other App
Store purchases; Homebrew's combined install/cleanup currently ignores the MAS
exclusion environment variable.

CleanShot X and Rex Beta use pinned upstream DMGs wrapped by Nix, with no source
compilation. Rex Beta remains on preview 1642, matching the previously installed
version; this is separate from Picard's Rex login server and CLI. Its first switch
backs up a manually installed `/Applications/Rex Beta.app` under
`~/Library/Application Support/nix-darwin/app-backups/` and creates an alias to
the managed copy in `/Applications/Nix Apps`. Calibre's first managed installation
replaces its older manual app bundle; its library and preferences stay in place.

## Edge Routing Model

- Shared edge settings live in `modules/infra/reverse-proxy.nix`.
- App modules (for example `modules/apps/immich.nix` and `modules/apps/paperless.nix`) only declare their own `services.caddy.virtualHosts` entries and local upstream target.
- CoreDNS generates private LAN and tailnet records from those declared proxy hosts; additional private overrides go under `homelab.infra.edgeDns.extraRecords`. Other `leolab.party` names resolve directly through Cloudflare (`1.1.1.1` / `1.0.0.1`). Public records for external services remain in Cloudflare; opted-in homelab hosts can be published from Nix.
- `homelab.apps.*` is reserved for subdomain-routed app modules; supporting platform services belong under `homelab.infra.*`.
- ACME and public-host reconciliation read the raw API token from `op://Homelab/Cloudflare/CLOUFLARE_ACCESS_TOKEN` through opnix. ACME supplies it to Lego using `CF_DNS_API_TOKEN_FILE` and systemd credentials; the secret stays outside the Nix store.

### Internal service APIs

Declare `homelab.infra.edge.internalProxies.<name>.upstream` to serve
`<name>.internal.leolab.party`. Entries share one Caddy access policy
(`internalAllowedClientRanges`): loopback, Podman bridge and Tailscale by default.
They generate private DNS records and add the internal wildcard certificate.
Trusted-proxy handling preserves the boundary for Cloudflare tunnel requests;
competing ordinary proxy declarations in this namespace are rejected.

`homelab.infra.aiGateway` provides OpenCode Zen inference through Chat Completions
and Jev System One, with separate model allowlists and defaults. Opnix supplies
`apiKeyReference`; callers need no key. Streaming and tool-call payloads pass
through. Defaults are 16 MiB bodies, eight active requests and ten minutes total;
disconnects cancel inference, with no automatic retries or content logging.

### Publishing a homelab service

Set the flag on the service's existing edge hostname in `machines/picard/homelab.nix`:

```nix
homelab.infra.edge.proxies.photos.public = true;
```

Nix merges this flag with the proxy declared by the app module, so its upstream
does not need to be repeated. The generated manifest contains only opted-in
hosts. Once applied, `cloudflare-publication.service` creates a proxied CNAME to
the configured Cloudflare tunnel and a tunnel route through Caddy, with the
hostname set for both HTTP and TLS certificate verification. Local and Tailscale
DNS still point directly to Picard. Caddy's existing authentication rules apply
to public requests too; any separate login hostname must also be reachable by
those clients.

`homelab.infra.edge.rootProxy.public` publishes the domain root when a root proxy
exists. `homelab.infra.edge.webhooksPublic` publishes the shared webhook hostname
through its HTTP Caddy listener, which serves only the declared webhook routes.
IP-restricted `privateProxies` do not offer a public flag. Public hostnames must
be the domain root or a single subdomain label covered by Cloudflare's domain
certificate.

Picard runs the publication controller against its declared account, zone and
existing remote tunnel. Pocket ID (`auth.leolab.party`) is opted in for public
access. Existing dashboard-managed `webhooks.leolab.party` and
the external Short.io record for `link.leolab.party` remain unmanaged.

The controller reads its API token through opnix and systemd credentials. Picard
uses the same raw `CLOUFLARE_ACCESS_TOKEN` field as ACME; preserve that exact
1Password field spelling. The controller also accepts legacy dotenv files, but
Picard's secret contains only the token. It needs **Zone Read**, **DNS Edit** for
`leolab.party` and **Cloudflare Tunnel Edit** for the selected account.
`publication.apiTokenReference` defaults to the edge credential reference, so
both consumers follow the same configured source. The separate `tunnelCredential`
field remains the connector's run token, rather than its management API credential.
Tokens never enter the Nix store.

With no public flags and no previously owned resources, reconciliation only
reads zone/DNS metadata and does not require tunnel permissions.

The service runs at boot, after relevant configuration/secret changes and every
five minutes. A DNS comment marks its records; persistent route ownership lives
in `/var/lib/private/cloudflare-publication/state.json` and is included in
Picard's appdata backup. Removing a flag withdraws the owned DNS record before
removing its tunnel route. Leave `publication.enable = true` until that cleanup
has completed.

Existing records and tunnel routes are preserved. A collision fails before API
writes unless adoption is explicitly authorised:

```nix
homelab.infra.edge.webhooksPublic = true;
homelab.infra.cloudflareTunnel.publication.adoptExisting = [
  "webhooks.leolab.party"
];
```

Adoption only accepts a proxied CNAME already pointing at this tunnel and a
single hostname rule without path matching. It deliberately replaces that
hostname's route with the Caddy route. Remove the adoption entry after it has
succeeded. A false flag does not privatise an unowned dashboard record.

`nix build .#checks.x86_64-linux.cloudflare-publication` checks the generated Nix
manifest and controller behaviour with a fake Cloudflare API. The controller's
`--dry-run` argument reports intended changes without writing Cloudflare or
local state; its other arguments are `--config`, `--token-file` and `--state`.
After activation, `sudo systemctl start cloudflare-publication.service` requests
an immediate reconciliation; inspect its results with
`journalctl -u cloudflare-publication.service`.

## Runbook

### Picard Storage Tiers

- `homelab.mounts.fast` (`/mnt/fast`) is for active app data with low-latency access needs.
- `/mnt/media` is the single media tree exposed read-write from Unraid (`media` virtiofs tag). App modules hide the full mount and bind only approved subdirectories into each service. The unused `/mnt/slow` share is no longer attached.
- On picard, Paperless documents and Immich media live on `/mnt/fast`, so restoring the `documents` repository targets `/mnt/fast/...` paths.

### Authentication

Pocket ID 2.19.1 runs natively on Picard behind Caddy at `auth.leolab.party`.
Its application name is `LeoLab`, managed declaratively in Nix.
Pocket ID sign-in sessions last 30 days (`SESSION_DURATION=43200` minutes).
Its live SQLite database and uploads are on local disk in `/var/lib/pocket-id`;
`/mnt/fast` is virtiofs and does not hold the live database. Before the existing
appdata restic job, `pocket-id-backup.service` creates a consistent SQLite backup
and copies uploads to `/mnt/fast/appdata/pocket-id-backup`. The encryption key is
loaded from 1Password through systemd credentials and must be preserved for a restore.

OAuth2 Proxy provides the shared gateway at `login.leolab.party`, backed by
Pocket ID and restricted to the `admins` group. Both authentication hostnames
are public so they can serve publicly exposed protected apps. The apps themselves
are published only when their edge flag is enabled. Tinyauth and its private
hostname were removed on 6 October 2026.

Linkding, Paperless, Miniflux and Immich use native Pocket ID OIDC, preserving
existing accounts and data. Their separate client secrets come from the
`pocket-id-oidc-env` fields in their existing 1Password items, except Immich's
raw `pocket-id-client-secret`. Paperless's active field contains only its
`pocket-id` provider. Local recovery login remains available; Miniflux and Immich
have automatic account creation disabled. Pingvin keeps its separate existing
Pocket ID client and native login.

Protected edge routes use OAuth2 Proxy and reject configurations with the
gateway disabled. SilverBullet's PWA paths and Prowlarr's API-key paths retain
their explicit bypasses. `checks.x86_64-linux.authentication` exercises the
actual generated gates, OIDC, PKCE, group denial, cookie renewal, WebSockets,
POST bodies, spoofed headers, exact bypasses and SQLite backups. Changing Pocket
ID's hostname requires enrolling passkeys again at the new address.

### Jellyfin

Jellyfin runs natively on Picard, managed by `modules/apps/jellyfin.nix`, behind Caddy at `jellyfin.leolab.party`. Its private service namespace reads `/media/films` and `/media/tv` without write access; those paths bind to the shared media library. Persistent state is in `/mnt/fast/appdata/jellyfin`; regenerable cache and transcodes are in `/mnt/fast/cache/jellyfin`.

AMD VA-API uses the GPU passed through by Unraid. Encoding settings are reapplied on service start; network settings are seeded only on first start, while accounts and libraries remain managed in Jellyfin. Leave remote connections enabled for Tailscale clients: the trusted proxy forwards their actual IP addresses. Jellyfin listens on loopback and UPnP is disabled.

### Media automation

Sonarr, Radarr, Prowlarr, Seerr, and Syncthing run natively on Picard. Their app modules own loopback listeners, Caddy routes, and private systemd mount namespaces. Sonarr can write only the TV library and its download inbox; Radarr can write only the film library and its inbox; Syncthing can write only the seedbox source tree; Seerr and Prowlarr have no filesystem access to media. Syncthing initiates outbound connections to the managed SeedHost instance and accepts no inbound peers. Arr imports completed downloads as separate library copies.

`seedbox-cleanup` checks tracker obligations and library-import evidence every fifteen minutes after the preceding run. It removes managed torrents after the account class's required seed time plus one day, or after reaching a per-torrent ratio of 1.0, with matching tracker confirmation. Eligibility must persist for an hour, and library copies are verified again before removal. The module defaults to dry-run; Picard sets `homelab.automation.seedboxCleanup.apply = true`. Its connection details come from opnix, and its local media mounts are read-only. The operational layout and validation stage are documented in the private homelab repository's `services/media-automation/README.md`.

With `homelab.automation.mediaArchiveExtraction.enable`, native Unpackerr polls
the enabled Arr apps for completed archive downloads and waits for Syncthing
transfers before extraction. It sees only the writable download inboxes and
removes its extracted copies five minutes after import, retaining original
archives. Arr keys are loaded from existing configuration via systemd credentials
at startup; no secrets enter the Nix store. Picard enables this service.

### Pingvin Share X service module

`modules/apps/pingvin.nix` provides `homelab.apps.pingvin`. Picard enables it at
`https://share.leolab.party`, with native Pocket ID login and public sharing links.
Enabling it starts one Podman container, bound to
`127.0.0.1:3005`, with persistent SQLite, uploads and custom images in
`/var/lib/pingvin`. Its v2.1.0 image is pinned by digest and supports HTTP range
requests for seeking in browser-compatible media. Picard declares the public
edge route separately; recipients can open shared links without an account.
Uploading and administration require the Pocket ID `admins` group. Password
login, local registration and anonymous share creation are disabled. Its
Homepage entry defaults to disabled; Picard explicitly enables it.

The minimal configuration is:

```nix
homelab.apps.pingvin.enable = true;
```

`port`, `dataDir`, `uid` and `gid` are configurable. The container creates its
application user from the numeric UID/GID (both default to 1000), and tmpfiles
prepares the data and images directories with matching ownership. Keep the live
SQLite database on local disk. Mount dependencies prevent the service starting
before the configured data directory's filesystem is available.

With `settings = { };` and `configFile = null`, configuration stays in Pingvin's
web interface. The first registered account becomes the administrator; close
registration in the settings after creating it. The upstream default application
URL is `http://localhost:3000`, so set it to the URL used to access the service.

For declarative configuration, supply non-secret YAML settings:

```nix
homelab.apps.pingvin.settings = {
  general.appUrl = "http://localhost:3005";
  share.defaultExpiration = "7 days";
};
```

Pingvin disables its settings editor whenever a YAML file is mounted, including
when only a few keys are specified. For settings containing passwords or OIDC
client secrets, use `configFile = "/run/secrets/pingvin-config.yaml";` instead of
`settings`. Supply an absolute runtime path as a string, not a Nix path literal,
to keep the file out of the Nix store. The module copies it through a systemd
credential to a temporary, read-only container mount; its source can remain
root-readable. Arrange for the source file to exist before service start and
restart `podman-pingvin.service` after changing it. When registration is disabled
before the first start, the YAML must provision an administrator with upstream's
`initUser` settings or provide another working sign-in flow.

Alternatively, enable `oidc` alongside non-secret `settings`. Set `issuerUrl` and
`clientSecretReference`; `clientId` defaults to `pingvin`, and `allowedGroup` and
`adminGroup` default to `admins`. The confidential client needs the exact callback
`https://share.leolab.party/api/oauth/callback/oidc` and must allow the matching
Pocket ID group. Pingvin does not send PKCE, so this client uses its secret
without requiring PKCE. The module requests `openid email profile groups`,
creates accounts on OIDC sign-in, and maps the `groups` claim to access and
administration. It disables password login and local registration. `configFile`
cannot be combined with these OIDC options.

Opnix supplies `op://Homelab/Pingvin/oidc-client-secret` on Picard. Systemd loads
the root-readable secret as a credential and inserts it into the runtime
`/run/pingvin/config.yaml`, readable only by the container's UID. The Nix store
contains the settings template, with no client secret. Set `trustProxy = true`
behind the HTTPS edge and enable secure cookies in `settings`.

Picard sets `backupDir = "/mnt/fast/appdata/pingvin-backup"`. Before the existing
appdata restic job, `pingvin-backup.service` stops an active Pingvin container,
copies its database, uploads and images, verifies SQLite integrity, then restarts
it even if preparation fails. Sharing is briefly unavailable during preparation;
this avoids mismatched database and file snapshots. A failed preparation fails
the restic job. To restore, stop Pingvin, replace `/var/lib/pingvin` with the
prepared directory from a staged restic restore, restore numeric UID/GID ownership
and restart with the original OIDC client secret from 1Password.

### Adding New Secrets

`opnix-secrets.service` supports `sudo systemctl reload opnix-secrets.service`
to refresh out-of-band vault changes without stopping services which require
the loader. Nix activation also reloads it when its definition changes. Explicit
per-secret `services` lists can still restart consumers when their values change;
restarting the loader itself can stop its dependants.

```nix
# In any module
services.onepassword-secrets.secrets.my-secret = {
  reference = "op://Homelab/my-item/my-field";
  owner = "myuser";
  services = [ "my-service" ];  # Services to restart when secret changes
};

# Access in systemd service
script = ''
  SECRET=$(cat ${config.services.onepassword-secrets.secretsPath}/my-secret)
'';
```

### Restoring from Backup

Backups are configured per machine in each machine file under `homelab.infra.backup.jobs`, while `modules/infra/backup.nix` provides shared restic/opnix plumbing.

Repository layout:

- One B2 bucket per machine.
- One restic repository prefix per resource inside that bucket.
- Shape: `s3:{endpoint}/{machine-bucket}/{resource}`

Picard job URLs:

| Job | Repository |
|-----|-----------|
| `postgres` | `s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/postgres` |
| `appdata` | `s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/appdata` |
| `paperless` | `s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/paperless` |
| `notes` | `s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/notes` |
| `immich` | `s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/immich` |

Service data mapping (all covered by `appdata` job):

- Home Assistant config: `/mnt/fast/appdata/homeassistant/config`
- Zigbee2MQTT config: `/mnt/fast/appdata/ziqbee2mqtt/config`
- Paperless app state: `/mnt/fast/appdata/paperless`
- Pocket ID prepared database and uploads: `/mnt/fast/appdata/pocket-id-backup`

#### 1) Pick restore scope

- Single file (preferred when possible)
- Single service (state/data for one service)
- Full host data restore

#### 2) Pre-restore safety checks

```bash
# Verify backup and prune timers
systemctl list-timers 'restic-backups-*' 'restic-prune-*'
systemctl status restic-backups-appdata restic-backups-immich

# Stop affected services before restore (example: Paperless)
sudo systemctl stop paperless-scheduler
```

#### 3) Discover snapshots

```bash
# Enter a root shell and load the existing opnix credentials without printing them
sudo -i
set -a
. /var/lib/opnix/secrets/s3Credentials
set +a
export RESTIC_PASSWORD_FILE=/var/lib/opnix/secrets/resticPassword

restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/appdata snapshots
restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/paperless snapshots
```

#### 4) Restore to staging first

```bash
# Restore to staging directory, not directly to /
sudo mkdir -p /tmp/restore-appdata /tmp/restore-paperless
restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/appdata restore latest --target /tmp/restore-appdata
restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/paperless restore latest --target /tmp/restore-paperless
```

#### 5) Apply restored data and fix ownership

```bash
# Example targets for picard's current storage layout
sudo rsync -a --delete /tmp/restore-appdata/mnt/fast/appdata/ /mnt/fast/appdata/
sudo rsync -a --delete /tmp/restore-paperless/mnt/fast/documents/paperless/library/ /mnt/fast/documents/paperless/library/

# Fix service ownership where needed
sudo chown -R paperless:paperless /mnt/fast/appdata/paperless
sudo chown -R paperless:paperless /mnt/fast/documents
sudo chown -R immich:immich /mnt/fast/photos
```

#### 6) Start services and verify

```bash
sudo systemctl start paperless-scheduler
systemctl status paperless-scheduler
```

> [!TIP]
> To quickly browse backups before restoring, use `restic snapshots`, `restic ls latest`, and `restic find <pattern>`. For interactive browsing, mount temporarily with `restic mount /mnt/restic`.
