# Picard PostgreSQL Collation Refresh Plan

## Background
After a glibc upgrade, the OS collation version bumped from `2.40` to `2.42`.
PostgreSQL stores the version it was initialized with, causing:
- **Warnings** on every connection to existing databases (immich, paperless)
- **CREATE DATABASE failures** on template1, blocking new database creation (broke n8n setup)

## What's Already Done
- `postgresql-collation-refresh` systemd service runs `ALTER DATABASE ... REFRESH COLLATION VERSION`
  on **all** databases before `postgresql-setup.service` — prevents future CREATE DATABASE failures
  and clears the metadata mismatch warnings. This is metadata-only (cheap, runs every boot).

## Remaining: One-Time REINDEX

The collation refresh updates stored metadata but doesn't rebuild indexes that were built
against the old sort order. Indexes using collation-sensitive comparisons (text columns with
`LIKE`, `ORDER BY`, B-tree indexes on text) may return incorrect results until reindexed.

### Databases to REINDEX
- `immich` — text-heavy (search, filenames, tags)
- `paperless` — text-heavy (document titles, tags, correspondents)
- `n8n` — freshly created after the refresh, no stale indexes

### Execution
1. Deploy the updated config to picard (collation refresh service now covers all DBs).
2. SSH into picard.
3. Stop write-heavy services:
   ```
   systemctl stop immich-server paperless-web paperless-task-queue paperless-consumer paperless-scheduler podman-n8n
   ```
4. Reindex affected databases (as postgres user):
   ```
   sudo -u postgres psql -c "REINDEX DATABASE immich;"
   sudo -u postgres psql -c "REINDEX DATABASE paperless;"
   ```
5. Start services:
   ```
   systemctl start immich-server paperless-web paperless-task-queue paperless-consumer paperless-scheduler podman-n8n
   ```

### Verification
1. Check logs for absence of collation warnings:
   ```
   journalctl -u postgresql.service --since "5 min ago" | grep -i collation
   journalctl -u immich-server.service --since "5 min ago"
   journalctl -u paperless-web.service --since "5 min ago"
   ```
2. Verify services are running:
   ```
   systemctl is-active immich-server paperless-web podman-n8n
   ```
3. Spot-check app UIs: Immich search/sort, Paperless list/sort.

### Rollback
If DB behavior looks wrong after REINDEX:
1. Stop app services.
2. Restore from the latest verified PostgreSQL backup (`/mnt/fast/backup/postgres`).
3. Start services and re-validate.
