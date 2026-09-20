# Homelab infrastructure

NixOS configuration for my homelab.

## Key Features

- Remote access and SSH authentication through Tailscale
- Secret management using 1Password with [opnix](https://github.com/brizzbuzz/opnix)
- Backups of all critical data to Backblaze B2 using restic
- Edge reverse proxy on picard with Caddy and wildcard TLS via ACME DNS-01 (Cloudflare)
- Containerized and native services with persistent appdata on `/mnt/fast`

## Machines
- **picard (NixOS VM on laforge)**: Runs the homelab edge (reverse proxy, DNS), plus apps (Immich, Paperless-ngx, etc.). Laforge is the Unraid host with the storage array and SSD cache drives.
- **dax (Ubuntu VM on laforge)**: Runs Hermes independently of Nix. Picard provides its authenticated dashboard route, Telegram webhook forwarding, and backup collection. Dax's application configuration is maintained separately in the private homelab repository.

## Edge Routing Model

- Shared edge settings live in `modules/infra/reverse-proxy.nix`.
- App modules (for example `modules/apps/immich.nix` and `modules/apps/paperless.nix`) only declare their own `services.caddy.virtualHosts` entries and local upstream target.
- CoreDNS generates explicit LAN and tailnet records from those declared proxy hosts; non-proxy records are declared separately under `homelab.infra.edgeDns.extraRecords`.
- `homelab.apps.*` is reserved for subdomain-routed app modules; supporting platform services belong under `homelab.infra.*`.
- Cloudflare DNS credentials for ACME are sourced through opnix using a secret file that contains `CF_DNS_API_TOKEN=...`.

## Runbook

### Picard Storage Tiers

- `homelab.mounts.fast` (`/mnt/fast`) is for active app data with low-latency access needs.
- `/mnt/media` is the single media tree exposed read-write from Unraid (`media` virtiofs tag). App modules hide the full mount and bind only approved subdirectories into each service. The unused `/mnt/slow` share is no longer attached.
- On picard, Paperless documents and Immich media live on `/mnt/fast`, so restoring the `documents` repository targets `/mnt/fast/...` paths.

### Jellyfin

Jellyfin runs natively on Picard, managed by `modules/apps/jellyfin.nix`, behind Caddy at `jellyfin.leolab.party`. Its private service namespace reads `/media/films` and `/media/tv` without write access; those paths bind to the shared media library. Persistent state is in `/mnt/fast/appdata/jellyfin`; regenerable cache and transcodes are in `/mnt/fast/cache/jellyfin`.

AMD VA-API uses the GPU passed through by Unraid. Encoding settings are reapplied on service start; network settings are seeded only on first start, while accounts and libraries remain managed in Jellyfin. Leave remote connections enabled for Tailscale clients: the trusted proxy forwards their actual IP addresses. Jellyfin listens on loopback and UPnP is disabled.

### Media automation

Sonarr, Radarr, Seerr, and Syncthing run natively on Picard. Their app modules own loopback listeners, Caddy routes, and private systemd mount namespaces. Sonarr can write only the TV library and its download inbox; Radarr can write only the film library and its inbox; Syncthing can write only the seedbox source tree; Seerr has no filesystem access to media. The operational layout is documented in the private homelab repository's `services/media-automation/README.md`.

### Adding New Secrets

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
# Must run as root so the wrapper can load credentials from 1Password
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/appdata snapshots
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/paperless snapshots
```

#### 4) Restore to staging first

```bash
# Restore to staging directory, not directly to /
sudo mkdir -p /tmp/restore-appdata /tmp/restore-paperless
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/appdata restore latest --target /tmp/restore-appdata
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/paperless restore latest --target /tmp/restore-paperless
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
