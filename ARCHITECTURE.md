# Homelab Architecture

High-level overview of how traffic flows through the network and how the custom domain is resolved on the two trusted networks we use today.

## Domain & DNS
- **Domain**: `leolab.party`
- **Subdomains**: `service.leolab.party` (e.g., `immich.leolab.party`)
- **Split DNS (local & Tailscale)**:
  - Local network DNS resolves every declared edge hostname to the picard LAN IP so nearby clients talk directly to the reverse proxy.
  - Tailscale split DNS resolves the same declared hostnames to picard's Tailscale IP so tailnet clients also connect straight to the proxy without tunneling.
  - Because both paths keep the DNS name identical, TLS termination happens once on Caddy and every client still gets `https://service.leolab.party` regardless of location.

Split DNS is declared in `modules/infra/edge-dns.nix`, with separate LAN and tailnet zone files generated from the configured reverse-proxy hosts. These files contain private records and explicit private overrides (`homelab.infra.edgeDns.extraRecords`). Names absent from the private view are forwarded directly to Cloudflare's `1.1.1.1` / `1.0.0.1` resolvers, so public records such as the Short.io CNAME for `link.leolab.party` are managed only in Cloudflare. There is no zone synchronisation job or Cloudflare API credential for DNS fallback. Unknown names receive Cloudflare's answer, including `NXDOMAIN` when no public record exists.

Private service names override the whole name: missing record types return local `NODATA`, rather than exposing a public IPv6 address or HTTPS/SVCB address hint. The domain root is handled separately because the private zone always contains SOA/NS metadata. If a root proxy or extra root record exists, its A/AAAA/CNAME/HTTPS/SVCB/ANY queries stay local; other root queries, including MX and TXT, go to Cloudflare. Without a private root record, root address queries also go to Cloudflare. CoreDNS selects the public-root view before the local file plugin, avoiding accidental shadowing of public mail and verification records.

Both listeners cache answers for up to 300 seconds, subject to upstream TTLs; client and Cloudflare caches also affect propagation. An uncached public lookup needs internet connectivity, while private records remain local. The LAN listener forwards queries outside `leolab.party` to its configured upstream (currently the router at `192.168.2.1`); the tailnet listener serves only `leolab.party`.

CoreDNS can transfer the private zone files to future persistent secondaries, but no secondary is configured yet. Configured secondaries receive local SOA/NS metadata for refreshes and authorised AXFR/IXFR transfers. Public fallback answers are not included in those transfers: each secondary needs the same Cloudflare fallback and root-routing rules. `nix build .#checks.x86_64-linux.edge-dns` exercises the generated configuration with isolated upstreams, including private/public conflicts, public additions, outages, root routing, and secondary transfers.

The separate publication module, `modules/infra/cloudflare-publication.nix`, derives a runtime manifest from explicit public edge flags. Its Node TypeScript controller manages proxied tunnel CNAMEs and remote tunnel ingress through Caddy, while preserving other Cloudflare records, ingress rules and global tunnel settings. DNS comments and an atomic local ownership file constrain adoption and deletion. It installs routes before publishing DNS, and withdraws DNS before removing routes; interrupted runs retain both old and intended route claims for recovery. Before a tunnel update it reads the configuration again and rejects a detected concurrent edit, although Cloudflare offers no conditional update to eliminate the race between that read and write. See the README for publication, token permissions and adoption. The controller was deployed on 2026-10-05 and reconciles successfully; `auth.leolab.party` has a public flag. ACME and publication share the raw `op://Homelab/Cloudflare/CLOUFLARE_ACCESS_TOKEN` API token through opnix and systemd credentials.

## Network Architecture

### Reverse Proxy (Caddy on picard)
- **Port**: `:443` for all HTTPS traffic (local or over Tailscale).
- **TLS**: Wildcard certificate for `*.leolab.party`, renewed via DNS-01 so the proxy can answer securely on both networks.
- **Routing**: Caddy proxies each subdomain to its backend service on Picard.
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
