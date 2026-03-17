# Homelab Architecture

High-level overview of how traffic flows through the network and how the custom domain is resolved on the two trusted networks we use today.

## Domain & DNS
- **Domain**: `leolab.party`
- **Subdomains**: `service.leolab.party` (e.g., `immich.leolab.party`)
- **Split DNS (local & Tailscale)**:
  - Local network DNS resolves every subdomain to the picard LAN IP so nearby clients talk directly to the reverse proxy.
  - Tailscale split DNS resolves the same hostnames to picard's Tailscale IP so tailnet clients also connect straight to the proxy without tunneling.
  - Because both paths keep the DNS name identical, TLS termination happens once on Caddy and every client still gets `https://service.leolab.party` regardless of location.

Split DNS is served by CoreDNS on picard via `modules/infra/edge-dns.nix`, with separate LAN and tailnet listeners that both answer for `leolab.party`. The LAN listener also forwards non-`leolab.party` queries to public upstream resolvers, while the router advertises Cloudflare as secondary DNS for fallback if picard is unavailable.

## Network Architecture

### Reverse Proxy (Caddy on picard)
- **Port**: `:443` for all HTTPS traffic (local or over Tailscale).
- **TLS**: Wildcard certificate for `*.leolab.party`, renewed via DNS-01 so the proxy can answer securely on both networks.
- **Routing**: Caddy proxies each subdomain to the appropriate backend service on picard.
- **Module ownership**: `modules/infra/reverse-proxy.nix` owns ACME + Caddy defaults, while each app module contributes its own virtual host.
- **LAN reachability**: Firewall policy keeps DNS (`53/tcp`, `53/udp`) and edge HTTP(S) (`80/tcp`, `443/tcp`) open so local clients can resolve and reach services through the proxy.

### Access Flow
1. Local client resolves `service.leolab.party` via the home DNS server and connects to picard's LAN IP over HTTPS.
2. Tailscale client resolves the same hostname through split DNS and connects over HTTPS to the Caddy listener on picard's tailnet IP.
3. Caddy uses the request hostname to forward traffic to the correct backend service, reusing the same TLS certificate for every path.

### Service Isolation
- Backend services bind to localhost and only accept traffic that originates from the reverse proxy.
- Firewalls prevent unintended exposure so the only reachable endpoint is Caddy's TLS listener.

## Home Assistant
- Home Assistant runs in a Podman container on picard (`modules/apps/homeassistant.nix`), while MQTT runs as a native NixOS service (`modules/infra/mqtt.nix`).
- Tasmota onboarding baseline: configure MQTT host/user/password, set `SetOption19 1` for Home Assistant MQTT discovery, then restart the device so entities are auto-discovered in HA.
- Zigbee-native group membership and direct Zigbee binds are managed in Zigbee2MQTT (not in Home Assistant automations) because they react faster and stay in sync better; direct binds are used for blinds and TRADFRI remotes.

## OpenClaw
- OpenClaw runs as a native systemd service on picard (`modules/apps/openclaw.nix`) and is exposed through Caddy as `https://assistant.leolab.party`.
- OpenClaw's persisted state and workspaces use the standard layout under `/mnt/fast/appdata/openclaw` (for example `openclaw.json`, `workspace`, and `workspace-labby`).
- On picard, `openclaw` is a shell alias that runs the CLI as the `openclaw` service user against that persisted state directory.

## Data Model & Recovery

### Current Layout
- Service-owned persistent state is stored under `/mnt/fast/appdata/<appname>` (for example Home Assistant, OpenClaw, Zigbee2MQTT, and Paperless).
- User-generated datasets live in dedicated top-level directories on `/mnt/fast` (`/mnt/fast/photos` for Immich uploads, `/mnt/fast/documents` for Paperless media/consume).
- On picard, active media/documents are stored under `/mnt/fast` (virtiofs from Unraid).
- Database dump outputs are stored under `/var/backup`.

### Home Assistant Workflow Today
- Home Assistant is currently managed through its own `configuration.yaml` in `/mnt/fast/appdata/homeassistant/config`.
- We make config changes there directly and then restart the `home-assistant` service to apply them.
- This is intentionally documented as the current state, but it is not the Nix-native workflow (declarative config in this flake).

### Current Database Backup
- PostgreSQL is enabled where needed by services.
- `services.postgresqlBackup` is enabled when PostgreSQL is enabled.
- PostgreSQL dump outputs are included in the daily state backup job.

### Current Backup Jobs
- Restic job `state` runs daily and backs up `/var/backup` plus `/mnt/fast/appdata`.
- Restic job `documents` runs weekly and backs up configured bulk-data paths (for picard: `/mnt/fast/documents` and `/mnt/fast/photos`).
- Excludes are configured per job for regenerable paths such as thumbnails, cache, temp files, and ingest directories.

### Current Recovery Model
- Rebuild `<machine>` from this flake.
- Restore the restic repositories for `state` and `documents`.
- Restart services after data restore.
