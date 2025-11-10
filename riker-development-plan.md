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

### Milestone 1: Basic Riker Setup & Tailscale
**Goal:** Establish secure remote access and basic configuration structure.

**Tasks:**
- [ ] Connect to riker and review current NixOS configuration
- [ ] Set up initial directory structure locally
  - [ ] Create `hosts/riker/` directory
  - [ ] Create `modules/` directory structure
  - [ ] Create `modules/secrets/` for 1Password integration
- [ ] Create base configuration for riker
  - [ ] User account (leo) with SSH keys
  - [ ] Basic system packages
  - [ ] Firewall configuration (port 22 initially)
- [ ] Set up 1Password integration with opnix
  - [ ] Create "Homelab" vault in 1Password
  - [ ] Create 1Password Service Account for riker
  - [ ] Generate Tailscale auth key (reusable + persistent)
  - [ ] Store Tailscale auth key in 1Password
  - [ ] Configure opnix module in NixOS
- [ ] Install and configure Tailscale
  - [ ] Add Tailscale service to configuration
  - [ ] Configure Tailscale to use auth key from 1Password (via opnix)
  - [ ] Configure Tailscale SSH feature
  - [ ] Test connectivity from remote location via Tailscale
  - [ ] Test SSH access via `ssh leo@riker` (MagicDNS)
  - [ ] Verify services are only accessible via Tailscale
- [ ] (Optional) Close public SSH access
  - [ ] Remove port 22 from firewall allowedTCPPorts
  - [ ] Rely on Tailscale SSH + Hetzner console as backup

**Notes:**
- Services accessible ONLY via Tailscale (no public exposure)
- Use Tailscale MagicDNS names (`riker`) instead of hardcoded IPs
- Services bind to default interfaces, firewall restricts access
- Keep port 22 open initially for safety during Tailscale setup

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
**✓ DECIDED: Structured from the start**

```
/Users/leo/git/nix/               # Git repository (local development)
├── hosts/
│   ├── riker/
│   │   ├── configuration.nix      # Main entry point for riker
│   │   └── hardware-configuration.nix  # Will be copied from riker
│   └── picard/                    # Future
│       └── configuration.nix
├── modules/
│   ├── common.nix                 # Shared config (users, packages, etc.)
│   ├── tailscale.nix             # Tailscale service configuration
│   ├── services/
│   │   ├── paperless.nix         # paperless-ngx service module
│   │   └── backups.nix           # Restic backup configuration
│   └── secrets/
│       └── 1password.nix         # opnix integration module
├── initial-configuration.nix      # Old guinan config (reference)
├── plan.md                        # Original Raspberry Pi plan
└── riker-development-plan.md      # This file
```

**On riker (`/etc/nixos/`):**
- Symlink to git repository: `/etc/nixos` → `/path/to/git/nix`
- Or: Copy files from git repo to `/etc/nixos/` (simpler initially)
- `configuration.nix` imports `hosts/riker/configuration.nix`

### Configuration Principles
1. **Structured from start:** Simple but organized - easy to navigate and extend
2. **Keep it portable:** Separate host-specific from reusable config
3. **Document decisions:** Comment why, not just what
4. **Test incrementally:** Small changes, frequent rebuilds
5. **Secrets via 1Password:** Use opnix for secret management from the start
6. **No flakes yet:** Keep it simple, introduce flakes later if needed

## Current Status
**Active Milestone:** Ready to begin Milestone 1

**Next Steps:**
1. Connect to riker and review current state
2. Create initial directory structure locally
3. Begin Milestone 1 implementation

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
- Services bind to default interfaces, firewall restricts access
- Tailscale SSH available (integrated with ACLs and MFA)

### Host Information
- **riker:** Hetzner VPS, x86_64, NixOS, development/testing environment
- **picard:** Future main homelab server for production services
- **guinan:** Raspberry Pi 3B+, aarch64, NixOS, reverse proxy gateway (separate project)
