# Homelab infrastructure

NixOS configuration for my homelab.

## Key Features

- Remote access and SSH authentication through Tailscale
- Secret management using 1Password with [opnix](https://github.com/brizzbuzz/opnix)
- Backups of all critical data to Backblaze B2 using restic
- Edge reverse proxy on picard with Caddy and wildcard TLS via ACME DNS-01 (Cloudflare)
- Containerized and native services with persistent appdata on `/mnt/fast`

## Custom automation

Use TypeScript with Deno for custom automation, including the notification
gateway. Prefer Deno built-ins; use Nix or shell only for configuration and
small glue.

## Machines
- **picard (NixOS VM on laforge)**: Runs the homelab edge (reverse proxy, DNS), plus apps (Immich, Paperless-ngx, etc.). Laforge is the Unraid host with the storage array and SSD cache drives.
- **dax (Ubuntu VM on laforge)**: Runs Hermes independently of Nix. Picard provides its authenticated dashboard route, Telegram webhook forwarding, and backup collection. Dax's application configuration is maintained separately in the private homelab repository.

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

## Edge Routing Model

- Shared edge settings live in `modules/infra/reverse-proxy.nix`.
- App modules (for example `modules/apps/immich.nix` and `modules/apps/paperless.nix`) only declare their own `services.caddy.virtualHosts` entries and local upstream target.
- CoreDNS generates private LAN and tailnet records from those declared proxy hosts; additional private overrides go under `homelab.infra.edgeDns.extraRecords`. Other `leolab.party` names resolve directly through Cloudflare (`1.1.1.1` / `1.0.0.1`). Public records for external services remain in Cloudflare; opted-in homelab hosts can be published from Nix.
- `homelab.apps.*` is reserved for subdomain-routed app modules; supporting platform services belong under `homelab.infra.*`.
- ACME and public-host reconciliation read the raw API token from `op://Homelab/Cloudflare/CLOUFLARE_ACCESS_TOKEN` through opnix. ACME supplies it to Lego using `CF_DNS_API_TOKEN_FILE` and systemd credentials; the secret stays outside the Nix store.

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

Pocket ID 2.14.0 runs natively on Picard behind Caddy at `auth.leolab.party`.
Its application name is `LeoLab`, managed declaratively in Nix.
Its live SQLite database and uploads are on local disk in `/var/lib/pocket-id`;
`/mnt/fast` is virtiofs and does not hold the live database. Before the existing
appdata restic job, `pocket-id-backup.service` creates a consistent SQLite backup
and copies uploads to `/mnt/fast/appdata/pocket-id-backup`. The encryption key is
loaded from 1Password through systemd credentials and must be preserved for a restore.

Tinyauth remains the active gateway and OIDC issuer at `tinyauth.leolab.party`.
Changing Pocket ID’s hostname requires enrolling passkeys again at the new address. The edge supports selecting
`tinyauth` or `oauth2-proxy`, globally or per route, and rejects configurations
whose required gateway is disabled. The OAuth2 Proxy wrapper is imported but
currently disabled on Picard. `checks.x86_64-linux.authentication` exercises the
generated Caddy gates, OIDC login, WebSockets, group restrictions and SQLite backups.

`machines/picard/authentication-migration.nix` defines six optional migration
stages under `homelab.infra.authenticationMigration`: `gateway`, `linkding`,
`paperless`, `miniflux`, `immich` and `gates`. All default to disabled. Enabling a
stage selects its separate Pocket ID credentials; those fields must exist before
activation. The gates stage requires the gateway stage. The
`authentication-migration` check verifies staged settings and unchanged Pocket
ID, Pingvin and tunnel unit derivations.

### Jellyfin

Jellyfin runs natively on Picard, managed by `modules/apps/jellyfin.nix`, behind Caddy at `jellyfin.leolab.party`. Its private service namespace reads `/media/films` and `/media/tv` without write access; those paths bind to the shared media library. Persistent state is in `/mnt/fast/appdata/jellyfin`; regenerable cache and transcodes are in `/mnt/fast/cache/jellyfin`.

AMD VA-API uses the GPU passed through by Unraid. Encoding settings are reapplied on service start; network settings are seeded only on first start, while accounts and libraries remain managed in Jellyfin. Leave remote connections enabled for Tailscale clients: the trusted proxy forwards their actual IP addresses. Jellyfin listens on loopback and UPnP is disabled.

### Media automation

Sonarr, Radarr, Prowlarr, Seerr, and Syncthing run natively on Picard. Their app modules own loopback listeners, Caddy routes, and private systemd mount namespaces. Sonarr can write only the TV library and its download inbox; Radarr can write only the film library and its inbox; Syncthing can write only the seedbox source tree; Seerr and Prowlarr have no filesystem access to media. Syncthing initiates outbound connections to the managed SeedHost instance and accepts no inbound peers. Arr imports completed downloads as separate library copies.

`seedbox-cleanup` installs a daily 3:00 AM timer that checks tracker obligations and library-import evidence. It defaults to dry-run; `homelab.automation.seedboxCleanup.apply` controls destructive removal. Its connection details come from opnix, and its local media mounts are read-only. The operational layout and validation stage are documented in the private homelab repository's `services/media-automation/README.md`.

### Pingvin Share X service module

`modules/apps/pingvin.nix` provides `homelab.apps.pingvin`. Picard enables it at
`https://share.leolab.party`, with native Pocket ID login and public sharing links.
Enabling it starts one Podman container, bound to
`127.0.0.1:3005`, with persistent SQLite, uploads and custom images in
`/var/lib/pingvin`. Its v2.0.0 image is pinned by digest and supports HTTP range
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
