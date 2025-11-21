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
  - [x] Create `machines/riker/` directory
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

### Milestone 2: paperless-ngx Deployment ✅ COMPLETE
**Goal:** Deploy first real service as a blueprint for future services.

**Status:** Completed successfully with production-ready configuration

**Tasks:**
- [x] Design service module structure
  - [x] Create `modules/services/paperless.nix`
  - [x] Define reusable patterns for service deployment
  - [x] Plan data directory structure
- [x] Configure paperless-ngx service
  - [x] Enable paperless-ngx NixOS module
  - [x] Configure database (PostgreSQL)
  - [x] Configure Redis for task queue
  - [x] Set up data directories
  - [x] Configure OCR and document processing
- [x] Test service
  - [x] Access web interface via Tailscale (http://riker:28981)
  - [x] Upload test documents
  - [x] Verify OCR processing
  - [x] Test search functionality
- [x] Document the deployment pattern for future services

**Key Achievements:**
- **Clean service module pattern:** Well-documented with clear sections for secrets, database, and service config
- **Manual PostgreSQL setup:** Handled NixOS 24.05 limitation (database.createLocally not available)
- **Secret management:** OpNix integration for admin password only (Django SECRET_KEY auto-generated)
- **Accessible via Tailscale:** http://riker:28981 (no public exposure)
- **Production OCR:** English language support with optimized settings
- **Service dependencies:** Proper systemd ordering with opnix-secrets.service

**Lessons Learned:**
- NixOS 24.05 requires manual PostgreSQL configuration (ensureDatabases/ensureUsers)
- Django SECRET_KEY auto-generated by NixOS (stored in /var/lib/paperless/nixos-paperless-secret-key)
- Admin password needs OpNix secret, other credentials handled automatically
- Service module pattern: secrets → database → service → dependencies
- Inline documentation is valuable for future reference

### Milestone 3: Backblaze B2 Backups ✅ COMPLETE
**Goal:** Implement automated backups of service data to Backblaze B2 using restic.

**Status:** Completed successfully with dual-tier backup strategy

**Tasks:**
- [x] Set up Backblaze B2 bucket
  - [x] Create B2 account/bucket for riker backups
  - [x] Generate application key (keyID + applicationKey)
  - [x] Store B2 credentials in 1Password "Homelab" vault
- [x] Configure restic backup solution
  - [x] Install restic via NixOS
  - [x] Configure restic to use B2 backend via S3 API
  - [x] Set up B2 credentials via opnix (from 1Password)
  - [x] Initialize restic repository on B2
  - [x] Generate and store restic repository password in 1Password
- [x] Configure paperless-ngx data backup
  - [x] Identify data directories to backup (PostgreSQL dumps, documents, media, OCR data)
  - [x] Create systemd service for backup execution
  - [x] Create systemd timer for backup schedule (daily + weekly)
  - [x] Test initial backup
  - [x] Test restore process from backup
- [x] Implement backup monitoring
  - [x] Verify backups are running via systemd timer
  - [x] Check backup success/failure in journal logs
  - [x] Document restore procedure

**Key Achievements:**
- **Dual-tier backup strategy:** Separated critical data (daily) from large media files (weekly)
  - **Tier 1 (appdata-s3):** Daily backups at 3 AM - PostgreSQL dumps, app state, config
  - **Tier 2 (documents-s3):** Weekly backups on Sundays at 4 AM - original documents, archived PDFs
- **S3-compatible API:** Using Backblaze B2 S3 API (s3.eu-central-003.backblazeb2.com)
- **Automated PostgreSQL dumps:** `services.postgresqlBackup` handles database dumps automatically
- **Smart retention policies:** Different policies for each tier (daily/weekly/monthly)
- **Auto-initialization:** Repositories auto-initialize on first run
- **Repository unlocking:** Automatic unlock in case of previous failures
- **Service dependencies:** Proper systemd ordering with opnix-secrets.service

**Lessons Learned:**
- S3 API more reliable than native B2 API for restic
- Wolfgang's pattern works well: `s3:ENDPOINT/BUCKET/PREFIX`
- Separate credentials file for S3 (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION)
- PostgreSQL dumps via `services.postgresqlBackup` simpler than manual dumps
- Tier separation reduces backup time and bandwidth for large document collections
- Exclude regenerable data (thumbnails, search index, logs) from backups

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
├── machines/
│   └── riker/
│       └── configuration.nix      # Main entry point for riker
├── modules/
│   ├── common.nix                 # Shared config (users, packages, SSH, etc.)
│   ├── tailscale.nix             # Tailscale with native authKeyFile
│   ├── secrets/
│   │   └── 1password.nix         # opnix integration + service dependencies
│   └── services/
│       ├── paperless.nix         # Paperless-ngx document management
│       └── backup.nix             # Restic backups to Backblaze B2
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
**Active Milestone:** Milestone 4 - Documentation & Patterns

**Completed:**
- ✅ Milestone 1: Basic Riker Setup & Tailscale (fully automated deployment)
- ✅ Milestone 2: paperless-ngx Deployment (production-ready with PostgreSQL + Redis)
- ✅ Milestone 3: Backblaze B2 Backups (dual-tier strategy with restic)

**Summary:**
Riker is now a fully functional development environment with:
- Secure access via Tailscale (zero public exposure)
- Working paperless-ngx instance at http://riker:28981
- Automated daily backups (appdata) and weekly backups (documents) to Backblaze B2
- All secrets managed via 1Password + opnix
- Reproducible configuration tracked in Git

**Next Steps:**
1. Document configuration patterns established on riker
2. Create migration checklist for picard deployment
3. Document differences between VPS (x86_64) and Raspberry Pi (aarch64)
4. Plan next services to deploy (Home Assistant, media services, etc.)

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
