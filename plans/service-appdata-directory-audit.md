# Plan: Service appdata model and audit

## Objective

- Define and enforce one clear storage model for the Picard migration: persistent app state lives under `%appdata%/%appname%` (implemented as `${mounts.fast}/appdata/<appname>`), user-generated content lives in explicit top-level dirs (for example `${mounts.fast}/photos`, `${mounts.fast}/documents`), and everything else is treated as rebuildable/ephemeral.

## Storage policy (target state)

1. `appdata` convention
   - All service-owned persistent state goes under `${mounts.fast}/appdata/<appname>`.
   - Includes mutable config not managed by Nix, databases, indexes, and any cache we intentionally keep.
2. User-content convention
   - Human-authored/generated datasets stay in top-level dirs under `${mounts.fast}` (for example `photos`, `documents`).
   - Services may read/write these dirs, but these are not app-owned state directories.
3. Backup convention
   - Back up all of `${mounts.fast}/appdata`.
   - Back up selected top-level user-content dirs explicitly.
4. `/var` convention
   - Do not hardcode `/var/...` paths in our config when they only restate service defaults.
   - Keep `/var` paths only when they are an intentional non-default decision.

## Services and existing path definitions to review

1. `homeassistant`
   - Module option: `lab.services.homeassistant.configDir` defaults to `/var/lib/homeassistant` in `modules/services/homeassistant.nix`.
   - Picard override: `configDir = "${mounts.fast}/appdata/homeassistant/config"` in `machines/picard/configuration.nix`.
   - Container bind: `${cfg.configDir}:/config` in `modules/services/homeassistant.nix`.
2. `openclaw`
   - Module options: `dataDir` defaults to `/var/lib/openclaw`; `workspaceDir` defaults to `${cfg.dataDir}/workspace` in `modules/services/openclaw.nix`.
   - Picard overrides: `dataDir = "${mounts.fast}/appdata/openclaw/config"`, `workspaceDir = "${mounts.fast}/appdata/openclaw"` in `machines/picard/configuration.nix`.
   - Container binds and bootstrap scripts consume both dirs in `modules/services/openclaw.nix`.
3. `zigbee2mqtt`
   - Module option: `lab.services.zigbee2mqtt.dataDir` defaults to `/var/lib/zigbee2mqtt` in `modules/services/zigbee2mqtt.nix`.
   - Picard override: `dataDir = "${mounts.fast}/appdata/ziqbee2mqtt/config"` in `machines/picard/configuration.nix`.
   - Service and secret bootstrap write inside `cfg.dataDir` in `modules/services/zigbee2mqtt.nix`.
4. `immich`
   - Module option: `lab.services.immich.mediaDir` defaults to `/var/lib/immich` in `modules/services/immich.nix`.
   - Picard override: `mediaDir = "${mounts.fast}/photos"` in `machines/picard/configuration.nix` (this is user content, not appdata).
   - Need explicit check of where Immich app state (DB/metadata/thumbs) lands vs media uploads.
5. `paperless`
   - Module options: `mediaDir` defaults to `/var/lib/paperless/media`; `consumptionDir` defaults to `/var/lib/paperless/consume` in `modules/services/paperless.nix`.
   - Module also sets `services.paperless.dataDir = lib.mkDefault "/var/lib/paperless"` and tmpfiles entry for `/var/lib/paperless`.
   - Picard overrides: `mediaDir = "${mounts.fast}/documents"`, `consumptionDir = "${mounts.fast}/documents/consume"` in `machines/picard/configuration.nix`.
   - Need explicit decision whether Paperless internal app state moves to `${mounts.fast}/appdata/paperless`.

## Cross-cutting config locations to review

- `machines/picard/configuration.nix`
  - `backupPaths.state` currently includes explicit `/var/lib/immich` and `/var/lib/paperless`.
  - `systemd.tmpfiles.rules` currently includes `/var/backup` and many per-service appdata dirs.
  - `system.activationScripts.picardStorageDirs` duplicates appdata/user-content directory bootstrap.
- `modules/services/homeassistant.nix`
  - Remove `/var` default reference if we decide to rely on upstream default when unset.
- `modules/services/openclaw.nix`
  - Remove `/var` default reference if relying on service default behavior.
- `modules/services/zigbee2mqtt.nix`
  - Remove `/var` default reference if relying on NixOS service default.
- `modules/services/immich.nix`
  - Re-evaluate `mediaDir` default and document split between user content and app state.
- `modules/services/paperless.nix`
  - Remove explicit `/var/lib/paperless` defaults/mkDefault/tmpfiles where they only mirror defaults.

## Implementation steps

1. Normalize the model in code
   - Introduce one appdata root (`${mounts.fast}/appdata`) as the only explicit root for app-owned persistent state.
   - Keep user-content roots explicit and separate.
2. Remove unnecessary `/var` references
   - Drop service option defaults that only restate service defaults.
   - Keep explicit paths only when they intentionally diverge from default behavior.
3. Repoint services that still persist outside policy
   - Ensure each enabled service either writes to `${mounts.fast}/appdata/<appname>` or intentionally uses default ephemeral locations.
4. Simplify backup inputs
   - Change backup job inputs to include `${mounts.fast}/appdata` plus selected user-content dirs.
   - Remove path-by-path app state lists where possible.
5. Validate rebuild semantics
   - Confirm that deleting/rebuilding host while preserving mounted data keeps wanted state and safely discards the rest.
6. Post-migration filesystem cleanup audit
   - Scan mounted filesystems for legacy service state paths from the pre-appdata layout.
   - For each legacy path, decide `migrate`, `archive`, or `delete` and record why.
   - Remove only after backup/restore verification confirms no service still depends on it.

## Exit criteria

- For each enabled service, we can answer in one line: app state path, user-content path (if any), and backup policy.
- `${mounts.fast}/appdata` is complete enough to restore service state after rebuild.
- No config contains `/var/...` path settings that merely duplicate service defaults.
- Legacy pre-migration state directories have been reviewed and either migrated, archived, or safely deleted.
