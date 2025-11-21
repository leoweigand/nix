This repository is equal parts meant to be a way for me to learn NixOS and actual config for my homelab that has to work and be pretty stable, especially smart home-related systems.

Read the [architecture plan](./ARCHITECTURE.md) carefully to understand the goal for where this repository is headed.

We are loosely following [Wolfgang's repository](/Users/leo/git/notthebee-nix) as an inspiration. Don't blindly copy but always check it when I ask you to add something new that our system doesn't have yet.

I already have a somewhat similar setup but currently all manually set up with rasbian on the pi and Unraid on the server (we're migrating away from that).

I know very little about Nix, so always make sure to explain in detail what we're doing, especially with respect to the Nix language.

Let's document decisions in the README but only important high-level ones, not every implementation detail.

## Code Style

**Comments**: Keep comments helpful and concise. Focus on the "why" and non-obvious details.

**What to comment:**
- Non-obvious technical constraints or workarounds
- Cron/timer syntax (hard to read without explanation)
- Exotic or unclear NixOS options
- Shell command purposes (especially complex ones)
- Security or timing implications
- Group/permission meanings for learning purposes

**What NOT to comment:**
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
