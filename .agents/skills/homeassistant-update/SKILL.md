---
name: homeassistant-update
description: Use whenever the user is discussing or working on Home Assistant — automations, helpers, integrations, devices, configuration, or anything HA-related.
---

# Home Assistant apply workflow

Config files live at `/mnt/fast/appdata/homeassistant/` on `picard`. Reading/writing these files requires `sudo`.
HA is reachable at `https://home.leolab.party`.

The API token is in 1Password — retrieve it with:
```bash
op read "op://Homelab/Openclaw/ha-token"
```

## When to use

- edit/update/fix `configuration.yaml` or `automations.yaml`
- change Home Assistant automations/scripts/integrations
- "restart Home Assistant" / "apply/reload HA config changes"

## Prefer API over restart

Most changes don't need a full restart. Use the appropriate reload endpoint — it's instant and doesn't drop all connections:

| Changed | API call |
|---|---|
| `automations.yaml` | `POST /api/services/automation/reload` |
| `scripts.yaml` | `POST /api/services/script/reload` |
| `scenes.yaml` | `POST /api/services/scene/reload` |
| `configuration.yaml` (input_boolean, template, etc.) | Full restart (see below) |

```bash
curl -sf -X POST -H "Authorization: Bearer $HA_TOKEN" https://home.leolab.party/api/services/automation/reload
```

## Full restart (configuration.yaml changes only)

Only needed when `configuration.yaml` itself changes (new integrations, input_boolean, etc.):

```bash
curl -sf -X POST -H "Authorization: Bearer $HA_TOKEN" https://home.leolab.party/api/services/homeassistant/restart
```

Wait ~30s then verify HA is back:
```bash
curl -sf -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $HA_TOKEN" https://home.leolab.party/api/
```
Expected: `200`

## Verify a specific entity loaded

```bash
curl -sf -H "Authorization: Bearer $HA_TOKEN" https://home.leolab.party/api/states/input_boolean.is_dark
```

## Fallback: SSH service restart

Only if the API is unreachable:
```bash
ssh picard 'sudo systemctl restart podman-homeassistant.service'
ssh picard 'journalctl -u podman-homeassistant.service -n 80 --no-pager'
```
