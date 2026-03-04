# Plan: Re-enable IPv6 DNS for LAN

## Goal
- Re-enable IPv6 on the router without breaking split DNS for `*.leolab.party`.

## Current blocker
- LAN clients prefer IPv6 DNS when available.
- `edge-dns` currently listens on IPv4 LAN only, so IPv6 DNS advertisement bypasses local split DNS.

## Plan
1. **Add IPv6 listener support in `modules/edge-dns.nix`**
   - Extend `lab.edgeDns` options to support LAN IPv6 listen/answer addresses.
   - Generate a CoreDNS block bound to picard's LAN ULA (not temporary IPv6).
   - Keep forwarding for non-`leolab.party` queries on the LAN listener.

2. **Choose a stable IPv6 identity for picard**
   - Use picard's stable ULA (`...:5054:ff:fe8b:2db1`) if FRITZ!Box keeps it stable.
   - If needed, pin a static IPv6 (DHCPv6/static assignment) so DNS target does not rotate.

3. **Router rollout**
   - Re-enable IPv6.
   - Set advertised DNSv6 server to picard's stable ULA.
   - Keep IPv4 DNS primary as `192.168.2.4` during rollout.

4. **Validation**
   - From a LAN client:
     - `dig +short paperless.leolab.party` -> `192.168.2.4`
     - `dig +short AAAA paperless.leolab.party` -> empty/NXDOMAIN (expected with current policy)
     - `dig +short google.com` -> resolves normally
     - `curl -I https://paperless.leolab.party` -> HTTP response from Caddy/app
   - Confirm macOS/Linux resolvers list picard IPv6 DNS and still resolve local services correctly.

5. **Docs update**
   - Add a short note in `ARCHITECTURE.md` describing IPv6 DNS behavior and why stable ULA is required.
