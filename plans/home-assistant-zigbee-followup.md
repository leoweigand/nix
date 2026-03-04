# Home Assistant follow-up plan

Core Home Assistant setup on `picard` is complete and deployed (module, Caddy proxy, persistence, backup coverage, and runbook mapping).

## Remaining work

1. Add Zigbee USB stick integration once core HA operation is stable.
2. Pass the USB device through from Unraid to the `picard` VM and verify a stable path under `/dev/serial/by-id/`.
3. Extend `lab.services.homeassistant` with explicit device mapping support (for example `extraOptions` plus existing `extraVolumes`) for declarative radio passthrough.
4. Document how to identify the serial device and wire it into Home Assistant's Zigbee integration flow.
