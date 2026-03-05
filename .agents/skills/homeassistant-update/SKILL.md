---
name: homeassistant-update
description: Use when working on Home Assistant config changes (configuration.yaml, automations, integrations) and the user asks to apply/restart/verify HA on picard.
---

# Home Assistant apply workflow

Use this after editing Home Assistant files under `/mnt/fast/appdata/homeassistant/config` on `picard`.

## When to use

Use this skill when any of these appear in the request context:

- edit/update/fix `configuration.yaml`
- change Home Assistant automations/scripts/integrations
- "restart Home Assistant"
- "apply Home Assistant config changes"
- "reload Home Assistant after config edits"

## Apply steps

Run these commands in order:

```bash
ssh picard 'sudo test -f /mnt/fast/appdata/homeassistant/config/configuration.yaml'
ssh picard 'sudo systemctl restart podman-homeassistant.service'
```

## Verification steps

- Check service health:

```bash
ssh picard 'systemctl is-active podman-homeassistant.service'
```

- Confirm the container mount source is still correct:

```bash
ssh picard 'sudo podman inspect homeassistant --format "{{range .Mounts}}{{if eq .Destination \"/config\"}}{{.Source}}{{end}}{{end}}"'
```

- Review recent logs for startup/config errors:

```bash
ssh picard 'journalctl -u podman-homeassistant.service -n 80 --no-pager'
```

Expected mount source: `/mnt/fast/appdata/homeassistant/config`.
