# Plan: Service appdata directory audit

## Goal
- Build a single, accurate inventory of every directory used by homelab service modules for persistent data (configs, databases, media roots, caches/temp worth tracking) - the equivalent of Unraid `appdata` paths.

## Concise plan
1. **Enumerate declared paths in repo**
   - Scan only `modules/services/` for storage-related options (`dataDir`, `stateDir`, `configDir`, bind mounts, volume mounts, backup paths).
2. **Capture implicit/default state paths**
   - For each enabled service, confirm upstream/NixOS default persistence locations when no explicit path is set (typically under `/var/lib/<service>`).
3. **Classify each path**
   - Label paths as `critical state`, `config`, `bulk data`, or `recreatable cache/temp` so we can decide backup priority and storage tier.
4. **Publish an audit table in a plan doc**
   - Record: service, path, owner, purpose, currently backed up (`state`/`documents`/none), and desired target tier (`/var`, `/mnt/fast`, `/mnt/slow`).
5. **Turn gaps into follow-up tasks**
   - List missing backups, unclear ownership/permissions, and path standardization changes as small actionable items.

## Exit criteria
- We have one reviewed table that answers "where does each service write persistent files?" and highlights any backup/tier mismatches.
