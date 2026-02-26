This repository contains the nix configuration for my homelab machines but is also a learning resource for me. Read the [readme](./README.md) and [architecture](./ARCHITECTURE.md) to get a general understanding of what we're doing. When it comes to nix config, explain how everything works in detail, especially with respect to more peculiar aspects of the nix language or things to do with the nix ecosystem, packages, home manager etc.

A lot of what I'm doing here is inspired by [Wolfgang's repository](/Users/leo/git/notthebee-nix). When I ask you to add something new, check how things are done over there as one learning resource.

When planning new features, work in markdown files inside `plans/`. The readme and architecture document should only describe the status quo, unfinished projects should remain in plans.

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
