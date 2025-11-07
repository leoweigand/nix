# Homelab Architecture

## Overview
Two-machine setup with custom domain access, centralized authentication, and split public/private access paths.

## Infrastructure

### Hardware
- **Raspberry Pi**: Runs critical services (Home Assistant, reverse proxy, auth)
- **Main Server**: Runs standard homelab apps (Immich, Paperless-ngx, etc.)
- Both machines run NixOS

### Domain & DNS
- **Domain**: leolab.party
- **Subdomain structure**: `<service>.leolab.party` (e.g., `immich.leolab.party`)
- **DNS split-horizon**:
  - Public DNS (Cloudflare) → Cloudflare Tunnel
  - Local network DNS → Pi local IP (192.168.x.x)
  - Tailscale split DNS → Pi Tailscale IP (100.x.x.x)

## Network Architecture

### Reverse Proxy (Caddy on Pi)
- **Listens on**:
  - `:443` - External TLS connections (local network, Tailscale)
  - `:8080` - HTTP from Cloudflare Tunnel (localhost only)
- **Responsibilities**:
  - TLS termination (Let's Encrypt via DNS-01 challenge)
  - Request routing based on subdomain
  - Conditional authentication (via IP/header checks)
  - Proxying to backend services on Pi and server

### Authentication (Authentik on Pi)
- Single instance for all services
- Forward auth for apps without native OAuth
- OAuth/OIDC provider for apps that support it
- Passkey support for user authentication

### Public Access (Cloudflare Tunnel on Pi)
- Single tunnel serving all subdomains
- Connects to Caddy via `http://localhost:8080`
- No TLS between tunnel and Caddy (same machine)

## Traffic Flow

### Local Network Access
1. Client → Local DNS resolves to Pi local IP
2. Client → Caddy on Pi (HTTPS)
3. Caddy checks source IP (192.168.x.x range)
4. If private IP: skip auth, proxy to backend
5. Backend responds through Caddy

### Tailscale Access
1. Client → Tailscale DNS resolves to Pi Tailscale IP
2. Client → Caddy on Pi (HTTPS over Tailscale)
3. Caddy checks source IP (100.x.x.x range)
4. If Tailscale IP: skip auth, proxy to backend
5. Backend responds through Caddy

### Public Access
1. Client → Public DNS resolves to Cloudflare
2. Client → Cloudflare (HTTPS)
3. Cloudflare → Cloudflare Tunnel → Caddy on Pi (HTTP localhost)
4. Caddy checks for `CF-Connecting-IP` header
5. If from Cloudflare: require Authentik auth, then proxy to backend
6. Backend responds through Caddy → Tunnel → Cloudflare → Client

## Security Model

### Network Isolation
- Backend services firewalled to only accept connections from Pi
- Services optionally bind to localhost only (defense in depth)
- No direct IP/port access to applications

### Authentication Strategy
- **Internal access** (home network + Tailscale): No authentication required
- **Public access** (via Cloudflare): Authentik authentication required
- Authentication determined by source IP/headers at Caddy level

### TLS
- All external connections use TLS (Let's Encrypt certs)
- Cloudflare Tunnel → Caddy uses HTTP (localhost only, no TLS needed)
- Single wildcard cert for `*.leolab.party` via DNS-01 challenge

## Future Considerations

### Performance
- If Pi becomes a bottleneck, can deploy additional Caddy instance on server
- Split DNS records by hosting machine
- Both Caddy instances authenticate against same Authentik on Pi

### Service Exposure
- Start with all services private (no auth)
- Add public access + auth incrementally per service
- Can expose specific API routes publicly while keeping UI private

### Selective Public Access
- Some services may be fully public (with auth)
- Others accessible via Tailscale only
- Others have public API endpoints but private web UI
- Configured per-service in Caddy routing rules