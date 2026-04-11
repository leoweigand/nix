This repository contains the nix configuration for my homelab machines but is also a learning resource for me. Read the [readme](./README.md) and [architecture](./ARCHITECTURE.md) to get a general understanding of what we're doing. When it comes to nix config, explain how everything works in detail, especially with respect to more peculiar aspects of the nix language or things to do with the nix ecosystem, packages, home manager etc.

A lot of what I'm doing here is inspired by [Wolfgang's repository](/Users/leo/git/untrusted/notthebee-nix). When I ask you to add something new, check how things are done over there as one learning resource.

When planning new features, work in markdown files inside `plans/`. The readme and architecture document should only describe the status quo, unfinished projects should remain in plans. Make sure to collaboratively create plans with the user, not just write them in one shot–especially when requirements are not completely clear.

When a package or module requires a newer nixpkgs channel, prefer upgrading the repository's main nixpkgs input for everything instead of introducing a one-off secondary channel just for that dependency.

## Containerized Services (Podman/OCI)

When writing a NixOS module for a containerized service that communicates with a host service (e.g. PostgreSQL), three things must be configured together — missing any one leaves it broken:

1. **Host service listen address** — the host service must bind to the Podman bridge gateway (`10.88.0.1`), not just `localhost`. Use `lib.mkForce` if the NixOS module sets a conflicting default.
   ```nix
   services.postgresql.settings.listen_addresses = lib.mkForce "localhost,10.88.0.1";
   ```

2. **Firewall** — the NixOS firewall is deny-by-default and treats `podman0` as untrusted (unlike Docker, which punches through iptables automatically). Explicitly open any ports the container needs to reach on the host.
   ```nix
   networking.firewall.interfaces.podman0.allowedTCPPorts = [ 5432 ];
   ```

3. **Data directory ownership** — bind-mounted host directories must be owned by the UID the container process runs as. This UID usually doesn't exist on the host, so use the numeric form in tmpfiles rules.
   ```nix
   "d ${cfg.dataDir} 0750 1000 1000 - -"  # 1000 = node user inside n8n container
   ```

**Always use bridge networking (the Podman default). Never use `--network=host`.**

`--network=host` gives the container full access to the host's network namespace — it can reach any service and bind to any port, bypassing the firewall entirely. Bridge networking is the correct approach because it lets you declare exactly what the container is allowed to reach. The three configuration steps above aren't overhead; they're the security model working as intended.

`--network=host` also hides these requirements rather than eliminating them, so switching away from it later reveals everything at once.

## Code Style

**Comments**: Keep comments helpful and concise. Focus on the "why" and non-obvious details.

**Examples of what to comment:**
- Non-obvious technical constraints or workarounds
- Cron/timer syntax (hard to read without explanation)
- Exotic or unclear NixOS options
- Shell command purposes (especially complex ones)
- Security or timing implications
- Group/permission meanings for learning purposes

**Examples of what NOT to comment:**
- Obvious section headers (`# User configuration`)
- Self-explanatory standard NixOS options
- Decorative comment borders or ASCII art
- Verbose multi-line explanations restating the code

**Examples:**
- ✅ Good: `extraGroups = [ "wheel" ];  # wheel group provides sudo access`
- ✅ Good: `OnCalendar = "*-*-* 03:00:00";  # Daily at 3:00 AM`
- ✅ Good: `consumptionDirIsPublic = true;  # Allow all users to add documents`
- ✅ Good: `${restic} forget --prune  # Remove old snapshots according to retention policy`
- ✅ Good: `# NixOS 24.05 requires manual PostgreSQL configuration`
- ✅ Good: `# Wait for network to prevent DNS failures on first boot`
- ❌ Bad: `# Enable SSH - CRITICAL for remote operation`
- ❌ Bad: `# ---------- User Account Configuration ----------`
- ❌ Bad: Multi-paragraph explanations of what a service does
