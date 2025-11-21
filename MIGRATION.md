# Storage Architecture Migration Guide

## Overview

This guide covers migrating riker from the old directory structure to the new storage abstraction layer.

## Changes Summary

**Old Structure:**
```
/var/lib/paperless/          # Paperless app state (NixOS default)
/mnt/data/paperless/         # Paperless documents (manually configured)
/var/backup/postgresql/      # Database dumps
```

**New Structure:**
```
/mnt/storage/appdata/paperless/  # Paperless app state
/mnt/storage/data/paperless/     # Paperless documents
/var/backup/postgresql/          # Database dumps (unchanged)
```

## Migration Steps for Riker

### Option A: Fresh Deployment (Recommended for Testing)

If you're okay with temporarily losing service access during migration:

```bash
# 1. SSH to riker
ssh riker

# 2. Stop paperless services
sudo systemctl stop paperless-scheduler paperless-consumer paperless-task-queue paperless-web

# 3. Create backup snapshot (just in case)
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup/appdata backup \
  /var/lib/paperless /var/backup

# 4. Pull new configuration
cd /etc/nixos-config
git pull

# 5. Apply new configuration (creates /mnt/storage directories)
sudo nixos-rebuild switch --flake .#riker

# 6. Move existing data to new locations
sudo mkdir -p /mnt/storage/appdata
sudo mkdir -p /mnt/storage/data

# Move app state
sudo mv /var/lib/paperless /mnt/storage/appdata/paperless

# Move documents (if they exist)
if [ -d /mnt/data/paperless ]; then
  sudo mv /mnt/data/paperless /mnt/storage/data/paperless
fi

# 7. Fix ownership (paperless user should own everything)
sudo chown -R paperless:paperless /mnt/storage/appdata/paperless
sudo chown -R paperless:paperless /mnt/storage/data/paperless

# 8. Start services
sudo systemctl start paperless-scheduler

# 9. Verify service is working
curl http://localhost:28981
sudo systemctl status paperless-scheduler

# 10. Check logs for any errors
sudo journalctl -u paperless-scheduler -n 50
```

### Option B: Restore from Backup (Clean Slate)

If you want to test the backup/restore process:

```bash
# 1. SSH to riker
ssh riker

# 2. Stop paperless services
sudo systemctl stop paperless-scheduler paperless-consumer paperless-task-queue paperless-web

# 3. Remove old data (DANGEROUS - make sure backups exist!)
# sudo rm -rf /var/lib/paperless
# sudo rm -rf /mnt/data/paperless

# 4. Pull new configuration and rebuild
cd /etc/nixos-config
git pull
sudo nixos-rebuild switch --flake .#riker

# 5. Restore from backup
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup/appdata restore latest --target /
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup/documents restore latest --target /

# 6. Fix ownership
sudo chown -R paperless:paperless /mnt/storage/appdata/paperless
sudo chown -R paperless:paperless /mnt/storage/data/paperless

# 7. Start services
sudo systemctl start paperless-scheduler

# 8. Verify
curl http://localhost:28981
```

## Verification Checklist

After migration, verify:

- [ ] Directory structure exists:
  ```bash
  ls -la /mnt/storage/
  ls -la /mnt/storage/appdata/paperless/
  ls -la /mnt/storage/data/paperless/
  ```

- [ ] Ownership is correct:
  ```bash
  ls -la /mnt/storage/appdata/ | grep paperless
  # Should show: drwxr-x--- paperless paperless
  ```

- [ ] Paperless services are running:
  ```bash
  sudo systemctl status paperless-scheduler
  sudo systemctl status paperless-web
  ```

- [ ] Paperless web interface accessible:
  ```bash
  curl http://localhost:28981
  # Or browse to http://riker:28981 via Tailscale
  ```

- [ ] Backup paths are correct:
  ```bash
  # Check backup configuration references new paths
  sudo systemctl cat restic-backups-appdata-s3 | grep ExecStart
  ```

- [ ] Can upload a test document through the web interface

- [ ] Test backup runs successfully:
  ```bash
  # Trigger manual backup
  sudo systemctl start restic-backups-appdata-s3

  # Check status
  sudo systemctl status restic-backups-appdata-s3

  # View logs
  sudo journalctl -u restic-backups-appdata-s3 -n 100
  ```

## Rollback Plan

If something goes wrong:

```bash
# 1. Stop services
sudo systemctl stop paperless-scheduler paperless-consumer paperless-task-queue paperless-web

# 2. Revert configuration
cd /etc/nixos-config
git checkout HEAD~1  # Go back to previous commit
sudo nixos-rebuild switch --flake .#riker

# 3. Move data back to old locations
sudo mv /mnt/storage/appdata/paperless /var/lib/paperless
sudo mv /mnt/storage/data/paperless /mnt/data/paperless

# 4. Fix ownership
sudo chown -R paperless:paperless /var/lib/paperless
sudo chown -R paperless:paperless /mnt/data/paperless

# 5. Start services
sudo systemctl start paperless-scheduler
```

## Troubleshooting

### Service fails to start

```bash
# Check logs
sudo journalctl -u paperless-scheduler -n 100

# Common issues:
# - Wrong ownership: fix with chown -R paperless:paperless
# - Missing directories: check systemd.tmpfiles.rules ran
# - Permission denied: check directory permissions (0750)
```

### Backups failing

```bash
# Check backup service logs
sudo journalctl -u restic-backups-appdata-s3 -n 100

# Test restic manually
sudo restic -r s3:s3.eu-central-003.backblazeb2.com/leolab-backup/appdata snapshots

# Verify paths exist
ls -la /mnt/storage/appdata/
ls -la /mnt/storage/data/
```

### Web interface shows errors

```bash
# Check all paperless services
sudo systemctl status paperless-*

# Restart all paperless services
sudo systemctl restart paperless-scheduler paperless-consumer paperless-task-queue paperless-web

# Check PostgreSQL is running
sudo systemctl status postgresql
```

## Post-Migration Cleanup

After successful migration and verification:

```bash
# Remove old empty directories (if they exist and are empty)
sudo rmdir /mnt/data 2>/dev/null || echo "/mnt/data not empty or doesn't exist"

# Old /var/lib/paperless should now be empty or a symlink
# Only remove if completely empty
ls -la /var/lib/paperless/
```

## Next Steps

Once migration is complete on riker:

1. Monitor services for 24-48 hours
2. Verify automated backups run successfully
3. Test restore process from new backup structure
4. Document any issues encountered
5. Update riker-development-plan.md to mark migration complete
