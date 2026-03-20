# Plan: Broaden OpenClaw system access

## Context
OpenClaw is an AI agent gateway running on picard. Today it runs as a locked-down `openclaw` system user with access to only its own workspace. To be useful as a general-purpose homelab assistant, it needs to:
- Modify and apply the NixOS configuration
- Read/write the Home Assistant config directory and restart the service
- Call the Home Assistant HTTP API
- Be extensible for future tool integrations

## Changes

### 1. Shared nix config directory

The nix config repo currently lives at `~/nixos-config` (leo's home). Move it to a shared location so both `leo` and `openclaw` can access it.

- **New path**: `/opt/nixos-config`
- **New group**: `nixconfig`
- **Members**: `leo`, `openclaw`
- **Ownership**: `leo:nixconfig`, group-writable (`chmod g+ws` so new files inherit the group)

**Files to change:**
- `modules/common.nix` — add `nixconfig` group, add `leo` to it
- `modules/apps/openclaw.nix` — add `openclaw` to the `nixconfig` group
- `.agents/skills/server-deploy/scripts/deploy-server.sh` — update path from `~/nixos-config` to `/opt/nixos-config`

**Manual step on picard:**
```bash
sudo mv ~/nixos-config /opt/nixos-config
sudo chgrp -R nixconfig /opt/nixos-config
sudo chmod -R g+w /opt/nixos-config
sudo find /opt/nixos-config -type d -exec chmod g+s {} +
```

Note: the existing gitops deploy plan (`plans/picard-pull-based-gitops-deploy.md`) creates a `deploy` user that would also need access to this repo. When that plan is implemented, add `deploy` to the `nixconfig` group too.

### 2. Sudo rules for openclaw

OpenClaw needs passwordless sudo for a small set of commands:

| Command | Purpose |
|---------|---------|
| `nixos-rebuild switch --flake /opt/nixos-config#picard` | Apply nix config changes |
| `nixos-rebuild --rollback switch` | Roll back a bad deploy |
| `systemctl restart podman-homeassistant.service` | Restart HA after config edits |
| `systemctl status podman-homeassistant.service` | Check HA status |

**File to change:** `modules/apps/openclaw.nix` — add `security.sudo.extraRules` entry for the `openclaw` user with `NOPASSWD` for these specific commands.

### 3. Home Assistant config directory access

HA config lives at `/mnt/fast/appdata/homeassistant/config`, currently `root:root 0750`. OpenClaw needs to read and write files there (e.g., editing `configuration.yaml`, adding automations).

- **New group**: `homeassistant`
- **Members**: `openclaw`
- **Change tmpfiles rule**: `root:homeassistant 0770` so group members can read/write
- The Podman container runs as root inside, so it doesn't care about the host group

**File to change:** `modules/apps/homeassistant.nix` — create `homeassistant` group, update tmpfiles rule to use it, add `openclaw` to the group (via `openclaw.nix` or inline).

### 4. Home Assistant API token

The user has created `op://Homelab/Openclaw/ha-token` in 1Password.

- Register the secret via `services.onepassword-secrets.secrets` in the openclaw module
- Pass the resolved path as an environment variable (`HA_TOKEN_FILE`) to the openclaw service
- Add `opnix-secrets.service` to the service's `after`/`requires` dependencies

**File to change:** `modules/apps/openclaw.nix`

Also expose the HA URL as `HA_URL=http://127.0.0.1:8123` in the service environment so the agent knows where to reach it.

### 5. Extensibility for future integrations

Add an `extraEnvironment` option to the openclaw module so new credentials or config can be wired in from `homelab.nix` without touching the module internals:

```nix
extraEnvironment = lib.mkOption {
  type = lib.types.attrsOf lib.types.str;
  default = { };
  description = "Additional environment variables passed to the OpenClaw service";
};
```

These get merged into the service's `Environment` list.

### 6. Update deploy script

Update `.agents/skills/server-deploy/scripts/deploy-server.sh` to use `/opt/nixos-config` instead of `~/nixos-config`.

## File change summary

| File | Changes |
|------|---------|
| `modules/apps/openclaw.nix` | `nixconfig` + `homeassistant` group membership, sudo rules, opnix secret for HA token, `HASS_URL` + `HASS_TOKEN_FILE` env vars, `extraEnvironment` option, opnix service dependency |
| `modules/apps/homeassistant.nix` | Create `homeassistant` group, update tmpfiles ownership to `root:homeassistant 0770` |
| `modules/common.nix` | Create `nixconfig` group, add `leo` to it |
| `.agents/skills/server-deploy/scripts/deploy-server.sh` | Update repo path to `/opt/nixos-config` |

## Manual steps after deploy

1. Move the repo: `sudo mv ~/nixos-config /opt/nixos-config`
2. Fix ownership: `sudo chgrp -R nixconfig /opt/nixos-config && sudo chmod -R g+w /opt/nixos-config && sudo find /opt/nixos-config -type d -exec chmod g+s {} +`
3. Fix HA config group: `sudo chgrp -R homeassistant /mnt/fast/appdata/homeassistant/config`
4. Create the HA Long-Lived Access Token in the HA UI and save it to the 1Password item `op://Homelab/Openclaw/ha-token`
5. Update any local SSH aliases or scripts that reference `~/nixos-config`

## Security notes

- OpenClaw gets root-equivalent power via `nixos-rebuild switch` — it can change any part of the system config. This is accepted since it's a homelab and NixOS generations make rollback trivial.
- The sudo rules are still scoped to specific commands rather than blanket `ALL`, limiting accidental damage from a stray shell command.
- The HA token is stored in 1Password and injected at runtime via opnix — never hardcoded in the nix config.
