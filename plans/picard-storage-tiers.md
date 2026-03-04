# Picard storage tiers implementation plan

## Goal

- Keep the VM OS disk mostly rebuildable.
- Mount Unraid storage in the VM with named mounts:
  - `mounts.fast = "/mnt/cache"`
  - `mounts.slow = "/mnt/btrfs_merged"`
- Put active app data on fast storage and avoid unnecessary slow-tier activity.

## Fixed decisions

- Transport: virtiofs.
- Unraid shares:
  - fast: `nixos-cache`
  - slow: `nixos-merged`
- First data placements:
  - Paperless documents: `${mounts.fast}/documents`
  - Immich photo library: `${mounts.fast}/photos`

## Implementation steps

1. In `machines/picard/configuration.nix`, add named mount settings (`mounts.fast`, `mounts.slow`).
2. Add `fileSystems` entries for virtiofs mounts:
   - `${mounts.fast}` from `nixos-cache`
   - `${mounts.slow}` from `nixos-merged`
3. Repoint service paths:
   - Paperless documents -> `${mounts.fast}/documents`
   - Immich media -> `${mounts.fast}/photos`
4. Update backup job paths to match new storage paths.
5. Add a short README note describing fast vs slow intent and restore implications.

## Validation

- `nix flake check`
- `nixos-rebuild dry-run --flake .#picard`
- On the VM:
  - `findmnt /mnt/cache /mnt/btrfs_merged`
  - verify Paperless/Immich paths resolve to `/mnt/cache`
  - `systemctl status restic-backups-state restic-backups-documents`
- Confirm idle behavior does not repeatedly touch `/mnt/btrfs_merged`.

## Required input before coding

- Confirm the exact virtiofs tag names exposed by the Unraid VM config (expected: `nixos-cache`, `nixos-merged`).

## Unraid clickops coordination

- Work with the user step-by-step to verify Unraid VM/share settings before applying Nix changes.
- Keep this collaborative and explicit because Unraid configuration is clickops (not declarative in this repo).
