# Picard LAN DNS forwarding + fallback plan

## Goal

- Use `picard` as primary LAN DNS so local clients resolve `*.leolab.party` to local services.
- Keep internet DNS resilient by using Cloudflare as router secondary DNS if `picard` is unavailable.

## Implementation

1. **Extend CoreDNS on picard**
   - Keep authoritative `leolab.party` blocks as-is (LAN listener -> `192.168.2.4`, tailnet listener -> `100.104.119.103`).
   - Add a `.:53` forwarding block to upstream resolvers:
     - `forward . 1.1.1.1 1.0.0.1`
   - Keep recursion behavior explicit and only expose DNS on required interfaces.

2. **Router DNS settings**
   - Set DHCP-advertised DNS servers to:
     - Primary: `192.168.2.4` (picard)
     - Secondary: `1.1.1.1` (or `1.0.0.1`)
   - Note: some clients may query secondary DNS even when primary is healthy, which can bypass split DNS for `leolab.party`.

3. **Validation**
   - On LAN client:
     - `dig +short paperless.leolab.party` -> `192.168.2.4`
     - `dig +short immich.leolab.party` -> `192.168.2.4`
     - `dig +short google.com` -> resolves normally via picard forwarder
   - Failure test:
     - Stop DNS on picard (`sudo systemctl stop edge-dns`) and confirm general DNS still works via router secondary resolver.
   - Tailnet regression check:
     - `dig +short paperless.leolab.party` from Tailscale client still returns `100.104.119.103`.

4. **Docs update**
   - Add a short note in `ARCHITECTURE.md` that LAN uses picard DNS with upstream forwarding and Cloudflare fallback at the router.
