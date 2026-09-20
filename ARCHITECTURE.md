# Homelab Architecture

High-level overview of how traffic flows through the network and how the custom domain is resolved on the two trusted networks we use today.

## Domain & DNS
- **Domain**: `leolab.party`
- **Subdomains**: `service.leolab.party` (e.g., `immich.leolab.party`)
- **Split DNS (local & Tailscale)**:
  - Local network DNS resolves every declared edge hostname to the picard LAN IP so nearby clients talk directly to the reverse proxy.
  - Tailscale split DNS resolves the same declared hostnames to picard's Tailscale IP so tailnet clients also connect straight to the proxy without tunneling.
  - Because both paths keep the DNS name identical, TLS termination happens once on Caddy and every client still gets `https://service.leolab.party` regardless of location.

Split DNS is served by CoreDNS on picard via `modules/infra/edge-dns.nix`, with separate LAN and tailnet zone files generated from the configured reverse-proxy hosts. Exceptional records are explicit; `link.leolab.party` is a CNAME to Short.io. Unknown names return `NXDOMAIN` instead of matching a wildcard. The LAN listener also forwards non-`leolab.party` queries to public upstream resolvers, while the router advertises Cloudflare as secondary DNS for fallback if picard is unavailable. CoreDNS is prepared to transfer each view to a future persistent secondary, but no secondary is configured yet.

## Network Architecture

### Reverse Proxy (Caddy on picard)
- **Port**: `:443` for all HTTPS traffic (local or over Tailscale).
- **TLS**: Wildcard certificate for `*.leolab.party`, renewed via DNS-01 so the proxy can answer securely on both networks.
- **Routing**: Caddy proxies each subdomain to its backend service. Most run on Picard; Hermes runs on the separate Ubuntu VM Dax.
- **Module ownership**: `modules/infra/reverse-proxy.nix` owns ACME + Caddy defaults, while each app module contributes its own virtual host.
- **LAN reachability**: Firewall policy keeps DNS (`53/tcp`, `53/udp`) and edge HTTP(S) (`80/tcp`, `443/tcp`) open so local clients can resolve and reach services through the proxy.

### Access Flow
1. Local client resolves `service.leolab.party` via the home DNS server and connects to picard's LAN IP over HTTPS.
2. Tailscale client resolves the same hostname through split DNS and connects over HTTPS to the Caddy listener on picard's tailnet IP.
3. Caddy uses the request hostname to forward traffic to the correct backend service, reusing the same TLS certificate for every path.

### Service Isolation
- Backend services bind to localhost and only accept traffic that originates from the reverse proxy.
- Firewalls prevent unintended exposure so the only reachable endpoint is Caddy's TLS listener.

### Hermes on Dax

- Hermes runs as a normal Ubuntu installation on Dax, with administrative control confined to that VM. It has no host filesystem shares.
- Laforge's persistent libvirt network filter restricts Dax's private-network access and blocks IPv6. The private homelab repository owns that filter and the Ubuntu service definitions.
- `machines/picard/hermes-remote.nix` retains Tinyauth-protected dashboard routing to Dax port 9119 and a Home Assistant-only TLS listener on port 8444, permitted only from Dax. The existing Telegram webhook route forwards to Dax port 8443.
- Before the daily appdata backup, Picard pulls a consistent Hermes archive using a forced-command SSH key. Dax briefly stops its Hermes services for the export. Backup credentials remain on Picard.

## Home Assistant
- Home Assistant runs in a Podman container on picard (`modules/apps/homeassistant.nix`), while MQTT runs as a native NixOS service (`modules/infra/mqtt.nix`).
- Tasmota onboarding baseline: configure MQTT host/user/password, set `SetOption19 1` for Home Assistant MQTT discovery, then restart the device so entities are auto-discovered in HA.
- Zigbee-native group membership and direct Zigbee binds are managed in Zigbee2MQTT (not in Home Assistant automations) because they react faster and stay in sync better; direct binds are used for blinds and TRADFRI remotes.

## Data Model & Recovery

### Current Layout
- Service-owned persistent state is stored under `/mnt/fast/appdata/<appname>` (for example Home Assistant, Zigbee2MQTT, and Paperless).
- User-generated datasets live in dedicated top-level directories on `/mnt/fast` (`/mnt/fast/photos` for Immich uploads, `/mnt/fast/documents` for Paperless media/consume).
- Laforge exports one writable media tree to Picard at `/mnt/media`. The film and TV libraries live under `/mnt/media/library`; seedbox synchronization lands under `/mnt/media/sources/seedbox`.
- Media services do not receive the full `/mnt/media` tree. Their systemd mount namespaces contain explicit read-only or read-write bindings for the subdirectories each service owns.
- Other active data and documents are stored under `/mnt/fast` (virtiofs from Unraid).
- Database dump outputs are stored under `/mnt/fast/backup/postgres`.

### Home Assistant Workflow Today
- Home Assistant is currently managed through its own `configuration.yaml` in `/mnt/fast/appdata/homeassistant/config`.
- We make config changes there directly and then restart the `home-assistant` service to apply them.
- This is intentionally documented as the current state, but it is not the Nix-native workflow (declarative config in this flake).

### Current Database Backup
- PostgreSQL is enabled where needed by services.
- `services.postgresqlBackup` is enabled when PostgreSQL is enabled, dumping to `/mnt/fast/backup/postgres`.
- Dumps are picked up by the daily `postgres` restic job.

### Current Backup Jobs
All jobs run daily and prune on the first of each month. Retention: 7 daily, 4 weekly, 3 monthly.

| Job | Schedule | Paths |
|-----|----------|-------|
| `postgres` | 1:30 AM | `/mnt/fast/backup/postgres` |
| `appdata` | 3:00 AM | `/mnt/fast/appdata` |
| `paperless` | 3:30 AM | `/mnt/fast/documents/paperless/library` |
| `notes` | 4:00 AM | `/mnt/fast/notes` |
| `immich` | 4:30 AM | `/mnt/fast/photos` |

Excludes are configured per job for regenerable paths (thumbnails, cache, temp files).

### Current Recovery Model
- Rebuild `<machine>` from this flake.
- Restore the relevant restic job repositories (see README for restore procedure).
- Restart services after data restore.
