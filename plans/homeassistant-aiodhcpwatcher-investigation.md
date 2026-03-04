# Home Assistant `aiodhcpwatcher` investigation plan

## Goal

Understand whether `aiodhcpwatcher` `Operation not permitted` in the Home Assistant container is harmless in our setup or requires container capability/network changes.

## Tiny plan

1. Reproduce and capture current logs (`podman-homeassistant` + Home Assistant startup) and note exactly which integrations rely on DHCP discovery.
2. Confirm impact in practice (device discovery working vs missing) before changing privileges.
3. Test one change at a time in a branch:
   - container networking mode adjustment (if needed for discovery), then
   - capability/device additions only if networking alone is insufficient.
4. Keep the least-privileged working config and document tradeoffs in the module comments/README runbook.

## Exit criteria

- Either we confirm the warning is benign for current integrations and document that, or we land a minimal declarative fix with verification steps.
