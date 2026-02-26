# Homelab Architecture

High-level overview of how traffic flows through the network and how the custom domain is resolved on the two trusted networks we use today.

## Domain & DNS
- **Domain**: `leolab.party`
- **Subdomains**: `service.leolab.party` (e.g., `immich.leolab.party`)
- **Split DNS (local & Tailscale)**:
  - Local network DNS resolves every subdomain to the guinan LAN IP so nearby clients talk directly to the reverse proxy.
  - Tailscale split DNS resolves the same hostnames to guinan's Tailscale IP so tailnet clients also connect straight to the proxy without tunneling.
  - Because both paths keep the DNS name identical, TLS termination happens once on Caddy and every client still gets `https://service.leolab.party` regardless of location.

## Network Architecture

### Reverse Proxy (Caddy on guinan)
- **Port**: `:443` for all HTTPS traffic (local or over Tailscale).
- **TLS**: Wildcard certificate for `*.leolab.party`, renewed via DNS-01 so the proxy can answer securely on both networks.
- **Routing**: Caddy proxies each subdomain to the appropriate backend on guinan or picard.

### Access Flow
1. Local client resolves `service.leolab.party` via the home DNS server and connects to guinan's LAN IP over HTTPS.
2. Tailscale client resolves the same hostname through split DNS and connects over HTTPS to the Caddy listener on guinan's tailnet IP.
3. Caddy uses the request hostname to forward traffic to the correct backend service, reusing the same TLS certificate for every path.

### Service Isolation
- Backend services bind to localhost or the storage VM network and only accept traffic that originates from the reverse proxy.
- Firewalls prevent unintended exposure so the only reachable endpoint is Caddy's TLS listener.
