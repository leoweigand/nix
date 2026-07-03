# Hermes Agent Follow-Up

Status: deployed on `picard`; Telegram is configured; Codex OAuth bootstrap pending.

## Current State

- Hermes Agent runs on `picard` as a native NixOS service.
- Persistent state lives at `/mnt/fast/appdata/hermes`.
- Telegram long polling is configured through `op://Homelab/Hermes Agent/env`.
- The service uses Hermes' `openai-codex` provider setting, but the Codex OAuth credential still needs to be created for the `hermes` service user.
- No reverse proxy route is configured because long polling does not need inbound HTTP.

## Remaining Work

1. Bootstrap Codex OAuth as the `hermes` user:

```bash
sudo -H -u hermes env HERMES_HOME=/mnt/fast/appdata/hermes/.hermes hermes auth add openai-codex
```

If the interactive model selector is a better path on the deployed version:

```bash
sudo -H -u hermes env HERMES_HOME=/mnt/fast/appdata/hermes/.hermes hermes model
```

Hermes stores the credential in `/mnt/fast/appdata/hermes/.hermes/auth.json`. The service state directory is backed up through the existing `appdata` restic job.

2. Confirm the default Codex model id.

The Nix module currently defaults to:

```nix
services.hermes-agent.settings.model = {
  provider = "openai-codex";
  default = "gpt-5.4";
};
```

After OAuth is bootstrapped, check the model ids Hermes exposes through `hermes model`. If `gpt-5.4` is not available or not the desired default, update `homelab.apps."hermes-agent".model` in `machines/picard/homelab.nix`.

3. Verify service behavior after OAuth:

```bash
systemctl status hermes-agent
journalctl -u hermes-agent -f
sudo -H -u hermes env HERMES_HOME=/mnt/fast/appdata/hermes/.hermes hermes version
```

4. Decide whether long polling remains enough.

Keep long polling unless there is a concrete need for Telegram webhook mode. Webhooks require Telegram's servers to reach the HTTPS endpoint, so a local-only or tailnet-only `hermes.leolab.party` route will not work as the webhook target.

If webhook mode is chosen later, add these values to `op://Homelab/Hermes Agent/env`:

```text
TELEGRAM_WEBHOOK_URL=https://hermes.leolab.party/telegram
TELEGRAM_WEBHOOK_SECRET=...
TELEGRAM_WEBHOOK_PORT=8443
```

Then add a Caddy route for `hermes.leolab.party` that proxies to the Hermes webhook listener:

```nix
services.caddy.virtualHosts."hermes.leolab.party".extraConfig = ''
  reverse_proxy 127.0.0.1:8443
'';
```
