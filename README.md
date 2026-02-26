# Homelab infrastructure

NixOS configuration for my homelab.

## Key Features

- Remote access and SSH authentication through Tailscale
- Secret management using 1Password with [opnix](https://github.com/brizzbuzz/opnix)
- Backups of all critical data to Backblaze B2 using restic

## Machines
- **guinan (Raspberry Pi)**: Runs critical services (reverse proxy, dns, home assistant)
- **picard (Unraid server)**: Runs standard homelab apps (Immich, Paperless-ngx, etc.) in a NixOS VM on an Unraid host with a storage array and SSD cache drives.

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

> [!Warning]
> This part is a bit outdated from an earlier iteration, will need to simplify and edit at some point.

The `restic` command automatically loads credentials from 1Password (must run as root).

**List available snapshots:**
```bash
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup/appdata snapshots
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup/documents snapshots
```

```bash
# Restore appdata (PostgreSQL dumps, app state)
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup/appdata restore latest --target /

# Restore documents
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup/documents restore latest --target /

# Fix ownership (if needed)
sudo chown -R paperless:paperless /mnt/storage/appdata/paperless
sudo chown -R paperless:paperless /mnt/storage/data/paperless

# Start services
sudo systemctl start paperless-scheduler
```
