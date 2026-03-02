# Backup Restore Runbook Outline

This is a draft outline for the `README.md` runbook section.

Design assumption for backup layout (target state):

- One B2 bucket per machine.
- One restic repository prefix per resource inside that machine bucket.
- Pseudocode shape: `s3:{endpoint}/{machine-bucket}/{resource}`

Example:

- `s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/appdata`
- `s3:s3.eu-central-003.backblazeb2.com/leolab-backup-picard/documents`

## 1) When to use this runbook

- Data loss or corruption for one service (partial restore).
- New host bootstrap from existing backups.
- Full machine recovery after disk failure.

## 2) Restore scope (choose one)

- Single file restore.
- Single service restore (app state + optional DB).
- Full host data restore.

## 3) Repository map (must stay up to date)

- `appdata` repo:
  - Live targets: service state/config paths.
  - Includes: DB dumps from `/var/backup`.
  - Typical services impacted: Paperless, PostgreSQL.
- `documents` repo:
  - Live targets: user/content data paths.
  - Typical services impacted: Paperless media/consume paths.

## 4) Preconditions and safety checks

- Confirm opnix secrets are available (`resticPassword`, S3 credentials).
- Confirm network access to B2 endpoint.
- Stop affected services before restore.
- Restore to a staging directory first (do not write directly to `/`).
- Keep a safety copy of current on-disk data before overwriting.

## 5) Snapshot discovery

- List snapshots for the target repository.
- Identify candidate snapshot by date/host/path.
- Inspect files inside candidate snapshot before restoring.

## 6) Restore workflow (staged)

- Restore selected snapshot to staging path (e.g. `/tmp/restore-<resource>`).
- Validate expected files/structure in staging.
- Copy data into live path.
- Fix ownership/permissions for restored paths.
- Restart services in dependency order.

## 7) Service-specific recovery notes

- Document DB-first restore order where relevant.
- Document exact systemd units to stop/start per service.
- Document path ownership expectations (user/group) per service.

## 8) Post-restore verification

- Check `systemctl status` for all affected units.
- Validate app-level behavior (login, core read/write flow).
- Spot-check a few known files/documents.

## 9) Failure handling and rollback

- If restore output is wrong/incomplete, stop and keep current data untouched.
- Re-run with an earlier snapshot.
- If copy to live path already happened, restore from the pre-restore safety copy.

## 10) Operational metadata

- Expected RPO for each repo (based on timer schedule).
- Expected RTO rough estimate for partial vs full restore.
- Last reviewed date and owner of this runbook section.

> [!TIP]
> To quickly browse backups, use `restic snapshots`, `restic ls latest`, and `restic find <pattern>` before running a restore. If needed, mount the repo temporarily with `restic mount /mnt/restic` for interactive browsing.
