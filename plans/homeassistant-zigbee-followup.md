# Home Assistant follow-up plan

Core Home Assistant setup on `picard` is complete and deployed (module, Caddy proxy, persistence, backup coverage, and runbook mapping).

## Plan (Zigbee2MQTT path)

1. [x] Add a dedicated `lab.services.zigbee2mqtt` Nix module (`modules/services/zigbee2mqtt.nix`) that:
   - Configures native `services.zigbee2mqtt`
   - Uses the existing local Mosquitto broker (`lab.mqtt`)
   - Enables Home Assistant MQTT discovery
   - Publishes the Zigbee2MQTT frontend via Caddy (`zigbee.<baseDomain>`)
2. [x] Keep MQTT credentials out of the Nix store by generating `/var/lib/zigbee2mqtt/secrets.yaml` at runtime from opnix materialized secrets.
3. [x] Include Zigbee2MQTT state (`/var/lib/zigbee2mqtt`) in picard's `backup.jobs.state` dataset.
4. [x] Pass the Sonoff dongle through from Unraid to the `picard` VM.
5. [x] On picard, identify the stable by-id path and update:
   - `lab.services.zigbee2mqtt.enable = true;`
   - `lab.services.zigbee2mqtt.serialPort = "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_64f09a5b4dbeed11b2996b2e38a92db5-if00-port0";`
6. [ ] Deploy to picard and verify:
   - `systemctl status zigbee2mqtt`
   - Zigbee2MQTT frontend reachable via `https://zigbee.leolab.party`
   - Devices can join and appear in Home Assistant via MQTT discovery.

## Notes

- `serialAdapter = "zstack"` is the expected default for Sonoff Zigbee 3.0 USB Dongle Plus **P** (TI CC2652P).
- If the stick is the **E** variant (EFR32), switch to `serialAdapter = "ember"`.
