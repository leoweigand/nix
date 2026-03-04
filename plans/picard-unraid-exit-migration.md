# Picard Unraid exit migration plan

## Open decision to revisit first

- Pick one NVMe fast-tier layout before implementation:
  - mirrored (`raid1`-style) `btrfs` for resilience, or
  - single logical ~2 TB `btrfs` volume for capacity.
- Current default: mirrored `btrfs`.

## Goal

- Run `picard` directly on NixOS host hardware (no Unraid, no VM).
- Reuse existing Unraid XFS data disk(s) without formatting them.
- Accept temporary no-parity window during migration.

## Decisions captured

- Back up critical data to Backblaze/restic before cutover.
- Non-critical large media can tolerate migration risk.
- Unraid parity will not be reused; parity is rebuilt later with SnapRAID.
- HDD array data disk(s) remain `xfs` so they can be reused directly after Unraid removal.
- NVMe fast tier uses `btrfs` (mirrored by default unless changed in the open decision above).

## Target storage model (post-migration)

1. NVMe fast tier (`btrfs`) hosts NixOS root and high-churn service state.
   - Service state remains under `/var/lib/<service>` and `/var/backup`.
2. Existing HDD data disk(s) stay `xfs` and are mounted directly on NixOS.
3. `mergerfs` provides one pooled bulk mount for media/documents across HDD data disks.
4. Former Unraid parity disk is reformatted and used by `snapraid` as parity target.
5. `restic` remains the backup system for critical state/documents (parity is not backup).

## Migration phases

### Phase 0: Prepare and verify backups

1. Inventory current data locations (VM state, SSD cache, array data shares).
2. Run and verify restic backups for critical paths (state + documents).
3. Record restore commands and latest snapshot IDs.
4. Freeze non-essential writes before final sync windows.

Exit criteria:
- At least one verified fresh backup for all critical datasets.

### Phase 1: Drain SSD data into array

1. Copy important SSD-backed datasets to existing array data disk(s).
2. Use checksumming or `rsync --checksum` on critical datasets to verify copy integrity.
3. Keep directory structure that can be mounted/read directly from Linux later.

Exit criteria:
- SSD contains only what is needed for temporary operation.
- Critical data exists on array and in Backblaze.

### Phase 2: Install NixOS on SSD

1. Shut down VM workload and perform final incremental sync to array.
2. Install NixOS directly onto NVMe fast tier.
3. Bring up minimum host access stack first (SSH/Tailscale) to avoid lockout.
4. Mount existing XFS data disk(s) read-only first for validation, then read-write after checks.

Exit criteria:
- Host is reachable remotely.
- Array data mounts cleanly on NixOS.

### Phase 3: Rehydrate services on host

1. Reintroduce NixOS service modules on host (`/var/lib/...`, reverse proxy, DNS, app services).
2. Copy service data back from array to SSD only where low latency/high churn is needed.
3. Keep large media/documents on HDD pool and point services there where appropriate.
4. Validate permissions/ownership and service startup ordering.

Exit criteria:
- Core services healthy on host.
- External routing and TLS behavior match previous VM behavior.

### Phase 4: Add mergerfs and snapraid

1. Configure `mergerfs` pool over mounted XFS data disks.
2. Reformat old parity disk and mount it for SnapRAID parity.
3. Configure `services.snapraid` with content files on data disks and parity file on parity disk.
4. Run first full `snapraid sync` (long-running), then schedule periodic `sync` + `scrub`.

Exit criteria:
- Pooled mount live and stable.
- SnapRAID parity initialized and scheduled.

## Downtime and risk notes

- Planned downtime occurs during final cutover (VM stop, final sync, first host boot).
- There is no parity protection until initial SnapRAID sync completes.
- Keep original disks unchanged until host services are validated.

## Rollback strategy

1. If host cutover fails before destructive disk changes, boot back into previous Unraid setup.
2. If parity reconfiguration is already done, rely on restic + preserved data disks for recovery.
3. Do not wipe old data disks until stability is confirmed.

## Required implementation follow-up in this repo

1. Add/adjust `machines/picard` filesystem declarations for SSD + XFS mounts.
2. Add a `mergerfs` mount definition (likely `fsType = "fuse.mergerfs"`) with explicit create policy.
3. Add `services.snapraid` config and systemd timer policy (`sync`/`scrub`).
4. Repoint service data paths to the intended tier (SSD state vs pooled bulk data).
5. Update backup job path coverage to reflect final mount layout.
