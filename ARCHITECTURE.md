# Homelab Architecture

High-level overview of how traffic flows through the network and how the custom domain is resolved on the two trusted networks we use today.

## Domain & DNS
- **Domain**: `leolab.party`
- **Subdomains**: `service.leolab.party` (e.g., `immich.leolab.party`)
- **Split DNS (local & Tailscale)**:
  - Local network DNS resolves every subdomain to the picard LAN IP so nearby clients talk directly to the reverse proxy.
  - Tailscale split DNS resolves the same hostnames to picard's Tailscale IP so tailnet clients also connect straight to the proxy without tunneling.
  - Because both paths keep the DNS name identical, TLS termination happens once on Caddy and every client still gets `https://service.leolab.party` regardless of location.

Split DNS is served by CoreDNS on picard via `modules/edge-dns.nix`, with separate LAN and tailnet listeners that both answer for `leolab.party`.

## Network Architecture

### Reverse Proxy (Caddy on picard)
- **Port**: `:443` for all HTTPS traffic (local or over Tailscale).
- **TLS**: Wildcard certificate for `*.leolab.party`, renewed via DNS-01 so the proxy can answer securely on both networks.
- **Routing**: Caddy proxies each subdomain to the appropriate backend service on picard.
- **Module ownership**: `modules/reverse-proxy.nix` owns ACME + Caddy defaults, while each app module contributes its own virtual host.

### Access Flow
1. Local client resolves `service.leolab.party` via the home DNS server and connects to picard's LAN IP over HTTPS.
2. Tailscale client resolves the same hostname through split DNS and connects over HTTPS to the Caddy listener on picard's tailnet IP.
3. Caddy uses the request hostname to forward traffic to the correct backend service, reusing the same TLS certificate for every path.

### Service Isolation
- Backend services bind to localhost and only accept traffic that originates from the reverse proxy.
- Firewalls prevent unintended exposure so the only reachable endpoint is Caddy's TLS listener.

## Data Model & Recovery

### Current Layout
- Service state is stored under `/var/lib/<service>`.
- On picard, active media/documents are stored under `/mnt/fast` (virtiofs from Unraid).
- Database dump outputs are stored under `/var/backup`.

### Current Database Backup
- PostgreSQL is enabled where needed by services.
- `services.postgresqlBackup` is enabled when PostgreSQL is enabled.
- PostgreSQL dump outputs are included in the daily state backup job.

### Current Backup Jobs
- Restic job `state` runs daily and backs up `/var/backup` and service state paths.
- Restic job `documents` runs weekly and backs up configured bulk-data paths (for picard: `/mnt/fast/documents` and `/mnt/fast/photos`).
- Excludes are configured per job for regenerable paths such as thumbnails, cache, temp files, and ingest directories.

### Current Recovery Model
- Rebuild `<machine>` from this flake.
- Restore the restic repositories for `state` and `documents`.
- Restart services after data restore.
