# Riker Development Plan

## Overview
Use Hetzner VPS "riker" as a development/testing environment for the NixOS configuration that will eventually run on "picard". This allows iteration and testing without risking the production Raspberry Pi setup.

## Quick Reference

**Key Technologies:**
- **OS:** NixOS (declarative Linux distribution)
- **Remote Access:** Tailscale (WireGuard-based mesh VPN)
- **Secrets:** 1Password + opnix (declarative secret management)
- **Backups:** Restic + Backblaze B2 (encrypted, deduplicated)
- **First Service:** paperless-ngx (document management system)

**Access Pattern:**
- All services accessible ONLY via Tailscale (no public exposure)
- Use MagicDNS names: `riker`, `picard`, etc.
- SSH via Tailscale (eventually replacing public SSH access)

## Environment
- **Host:** riker (Hetzner Cloud VPS)
- **OS:** NixOS (already installed)
- **Purpose:** Development/testing environment for services before deploying to picard
- **Lifecycle:** Temporary - will be deleted once picard is bootstrapped

## Scope
### In Scope
- Tailscale configuration and setup
- paperless-ngx deployment (real service + blueprint pattern)
- Backups to Backblaze B2 (data only)
- Direct service access (no reverse proxy yet)

### Out of Scope
- Reverse proxy integration (Caddy/nginx)
- Home Assistant
- Full production hardening
- guinan (Raspberry Pi) configuration

## Milestones

### Milestone 1: Basic Riker Setup & Tailscale ✅ COMPLETE
**Goal:** Establish secure remote access and basic configuration structure.

**Status:** Completed successfully with fully automated deployment

**Tasks:**
- [x] Connect to riker and review current NixOS configuration
- [x] Set up initial directory structure locally
  - [x] Create `hosts/riker/` directory
  - [x] Create `modules/` directory structure
  - [x] Create `modules/secrets/` for 1Password integration
- [x] Create base configuration for riker
  - [x] User account (leo) with SSH keys
  - [x] Basic system packages (git, vim, htop, curl, wget, tmux, jq)
  - [x] Firewall configuration (public SSH disabled)
- [x] Set up 1Password integration with opnix
  - [x] Create "Homelab" vault in 1Password
  - [x] Create 1Password Service Account for riker
  - [x] Generate Tailscale auth key (reusable + persistent)
  - [x] Store Tailscale auth key in 1Password
  - [x] Configure opnix module in NixOS
- [x] Install and configure Tailscale
  - [x] Add Tailscale service to configuration
  - [x] Use native `services.tailscale.authKeyFile` (no custom service needed!)
  - [x] Configure Tailscale SSH feature via `extraUpFlags`
  - [x] Test connectivity from remote location via Tailscale
  - [x] Test SSH access via `ssh riker` (MagicDNS)
  - [x] Verify services are only accessible via Tailscale
- [x] Close public SSH access
  - [x] Set `services.openssh.openFirewall = false`
  - [x] Rely on Tailscale SSH + Hetzner console as backup

**Key Achievements:**
- **Fully automated deployment:** Two-step process (cloud-config + setup script)
- **Native Tailscale integration:** Eliminated custom service by using `authKeyFile`
- **Proper secret management:** OpNix pattern established for future services
- **Zero public exposure:** All access via Tailscale VPN only
- **Reproducible:** Can recreate server in ~10-15 minutes

**Lessons Learned:**
- NixOS 24.05 required for opnix (Go 1.22+ dependency)
- OpNix needs `network-online.target` to prevent DNS failures on boot
- Native `services.tailscale.authKeyFile` is more reliable than custom services
- Secret consumption pattern: `config.services.onepassword-secrets.secretPaths.<name>`
- Flakes are essential for reproducible deployments

### Milestone 2: paperless-ngx Deployment
**Goal:** Deploy first real service as a blueprint for future services.

**Tasks:**
- [ ] Design service module structure
  - [ ] Create `modules/services/paperless.nix`
  - [ ] Define reusable patterns for service deployment
  - [ ] Plan data directory structure
- [ ] Configure paperless-ngx service
  - [ ] Enable paperless-ngx NixOS module
  - [ ] Configure database (PostgreSQL)
  - [ ] Configure Redis for task queue
  - [ ] Set up data directories
  - [ ] Configure OCR and document processing
- [ ] Test service
  - [ ] Access web interface via Tailscale
  - [ ] Upload test documents
  - [ ] Verify OCR processing
  - [ ] Test search functionality
- [ ] Document the deployment pattern for future services

**Notes:**
- paperless-ngx serves as blueprint for future services
- Document: configuration approach, data management, database dependencies, networking/access patterns

### Milestone 3: Backblaze B2 Backups
**Goal:** Implement automated backups of service data to Backblaze B2 using restic.

**Tasks:**
- [ ] Set up Backblaze B2 bucket
  - [ ] Create B2 account/bucket for riker backups
  - [ ] Generate application key (keyID + applicationKey)
  - [ ] Store B2 credentials in 1Password "Homelab" vault
- [ ] Configure restic backup solution
  - [ ] Install restic via NixOS
  - [ ] Configure restic to use B2 backend
  - [ ] Set up B2 credentials via opnix (from 1Password)
  - [ ] Initialize restic repository on B2
  - [ ] Generate and store restic repository password in 1Password
- [ ] Configure paperless-ngx data backup
  - [ ] Identify data directories to backup (PostgreSQL dumps, documents, media, OCR data)
  - [ ] Create systemd service for backup execution
  - [ ] Create systemd timer for backup schedule (daily)
  - [ ] Test initial backup
  - [ ] Test restore process from backup
- [ ] Implement backup monitoring
  - [ ] Verify backups are running via systemd timer
  - [ ] Check backup success/failure in journal logs
  - [ ] Document restore procedure

**Notes:**
- Backup scope: Service data only (config in git, secrets in 1Password)
- Restic provides: built-in encryption, deduplication, snapshot management, native B2 support

### Milestone 4: Documentation & Patterns
**Goal:** Document learnings and create reusable patterns for picard migration.

**Tasks:**
- [ ] Document riker configuration structure
- [ ] Create migration checklist for picard
- [ ] Document service deployment patterns
- [ ] Note differences between VPS and Raspberry Pi
  - [ ] Architecture differences (x86_64 vs aarch64)
  - [ ] Boot loader differences
  - [ ] Network setup differences
- [ ] Create configuration organization guide

## Configuration Strategy

### Directory Structure
**✓ IMPLEMENTED**

```
/Users/leo/git/nix/               # Git repository (local development)
├── flake.nix                      # Flake configuration (NixOS 24.05 + opnix)
├── flake.lock                     # Locked dependencies
├── setup.sh                       # Automated deployment script
├── hosts/
│   └── riker/
│       └── configuration.nix      # Main entry point for riker
├── modules/
│   ├── common.nix                 # Shared config (users, packages, SSH, etc.)
│   ├── tailscale.nix             # Tailscale with native authKeyFile
│   ├── secrets/
│   │   └── 1password.nix         # opnix integration + service dependencies
│   └── services/                  # Future: paperless, backups, etc.
├── initial-configuration.nix      # Old guinan config (reference)
├── plan.md                        # Original Raspberry Pi plan
├── riker-development-plan.md      # This file
└── README.md                      # Deployment instructions
```

**On riker (`/etc/nixos-config/`):**
- Repository cloned to `/etc/nixos-config/` by setup script
- Deployed via: `nixos-rebuild switch --flake .#riker`
- Git ownership exception: `git config --global --add safe.directory /etc/nixos-config`

### Configuration Principles
1. **Structured from start:** Simple but organized - easy to navigate and extend
2. **Keep it portable:** Separate host-specific from reusable config
3. **Document decisions:** Comment why, not just what
4. **Test incrementally:** Small changes, frequent rebuilds
5. **Secrets via 1Password:** Use opnix for secret management from the start
6. **Flakes for reproducibility:** Pin dependencies and enable reproducible builds
7. **Use native options:** Prefer built-in NixOS options over custom solutions

## Current Status
**Active Milestone:** Milestone 2 - paperless-ngx Deployment

**Completed:**
- ✅ Milestone 1: Basic Riker Setup & Tailscale (fully automated deployment)

**Next Steps:**
1. Design service module structure for paperless-ngx
2. Configure paperless-ngx with PostgreSQL and Redis
3. Establish secret management pattern for service credentials
4. Document deployment pattern as blueprint for future services

## Implementation Notes

### 1Password + opnix
- opnix provides NixOS modules for 1Password integration
- Secrets fetched at activation time via 1Password CLI
- Requires 1Password Service Account token
- Reference: https://github.com/brizzbuzz/opnix
- Store in "Homelab" vault: Tailscale auth key, B2 credentials, restic password

### Tailscale
- All services accessible ONLY via Tailscale (no public exposure)
- Use MagicDNS names (`riker`) instead of hardcoded IPs
- Native integration via `services.tailscale.authKeyFile`
- Automatic authentication with auth key from 1Password/opnix
- Tailscale SSH enabled via `extraUpFlags = ["--ssh"]`
- Public SSH disabled (`services.openssh.openFirewall = false`)

### Deployment Process
**Automated two-step deployment:**

1. **Cloud-config** (Hetzner): Install base NixOS via nixos-infect
   ```yaml
   runcmd:
     - curl https://raw.githubusercontent.com/elitak/nixos-infect/master/nixos-infect | PROVIDER=hetznercloud NIX_CHANNEL=nixos-24.05 bash
   ```

2. **Setup script** (after reboot): Apply full configuration
   ```bash
   curl -sSL https://raw.githubusercontent.com/leoweigand/nix/main/setup.sh | \
     OPNIX_TOKEN=ops_xxx HOSTNAME=riker bash
   ```

**What gets configured:**
- User accounts with SSH keys
- 1Password token → `/etc/opnix-token`
- Repository cloned → `/etc/nixos-config/`
- Flake deployment → `nixos-rebuild switch --flake .#riker`
- OpNix fetches secrets from 1Password
- Tailscale auto-connects and enables SSH
- Firewall closes public SSH (Tailscale-only access)

### Host Information
- **riker:** Hetzner VPS, x86_64, NixOS, development/testing environment
- **picard:** Future main homelab server for production services
- **guinan:** Raspberry Pi 3B+, aarch64, NixOS, reverse proxy gateway (separate project)
