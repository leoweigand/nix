# Homelab infrastructure

NixOS configuration for my homelab.

## Key Features

- Remote access and SSH authentication through Tailscale
- Secret management using 1Password with [opnix](https://github.com/brizzbuzz/opnix)
- Backups of all critical data to Backblaze B2 using restic
- Edge reverse proxy on picard with Caddy and wildcard TLS via ACME DNS-01 (Cloudflare)

## Machines
- **picard (Unraid server)**: Runs the homelab edge (reverse proxy, DNS), plus apps (Immich, Paperless-ngx, etc.) in a NixOS VM on an Unraid host with a storage array and SSD cache drives.

## Edge Routing Model

- Shared edge settings live in `modules/reverse-proxy.nix`.
- App modules (for example `modules/services/immich.nix` and `modules/services/paperless.nix`) only declare their own `services.caddy.virtualHosts` entries and local upstream target.
- Cloudflare DNS credentials for ACME are sourced through opnix using a secret file that contains `CF_DNS_API_TOKEN=...`.

## Runbook

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

Backups are configured per machine in each machine file under `backup.jobs`, while `modules/services/backup.nix` provides shared restic/opnix plumbing.

Repository layout:

- One B2 bucket per machine.
- One restic repository prefix per resource inside that bucket.
- Shape: `s3:{endpoint}/{machine-bucket}/{resource}`

Examples:

- Picard state: `s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/state`
- Picard documents: `s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/documents`

#### 1) Pick restore scope

- Single file (preferred when possible)
- Single service (state/data for one service)
- Full host data restore

#### 2) Pre-restore safety checks

```bash
# Verify backup timers/services
systemctl list-timers 'restic-backups-*'
systemctl status restic-backups-state restic-backups-documents

# Stop affected services before restore (example: Paperless)
sudo systemctl stop paperless-scheduler
```

#### 3) Discover snapshots

```bash
# Must run as root so the wrapper can load credentials from 1Password
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/state snapshots
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/documents snapshots
```

#### 4) Restore to staging first

```bash
# Restore to staging directory, not directly to /
sudo mkdir -p /tmp/restore-state /tmp/restore-documents
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/state restore latest --target /tmp/restore-state
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/documents restore latest --target /tmp/restore-documents
```

#### 5) Apply restored data and fix ownership

```bash
# Example targets for picard's current storage layout
sudo rsync -a --delete /tmp/restore-state/var/lib/paperless/ /var/lib/paperless/
sudo rsync -a --delete /tmp/restore-state/var/backup/ /var/backup/
sudo rsync -a --delete /tmp/restore-documents/var/lib/picard/data/ /var/lib/picard/data/

# Fix service ownership where needed
sudo chown -R paperless:paperless /var/lib/paperless
sudo chown -R paperless:paperless /var/lib/picard/data/paperless
```

#### 6) Start services and verify

```bash
sudo systemctl start paperless-scheduler
systemctl status paperless-scheduler
```

> [!TIP]
> To quickly browse backups before restoring, use `restic snapshots`, `restic ls latest`, and `restic find <pattern>`. For interactive browsing, mount temporarily with `restic mount /mnt/restic`.
