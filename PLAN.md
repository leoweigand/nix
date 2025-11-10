# Raspberry Pi NixOS Setup Plan

## Overview
This plan outlines the progressive setup of a Raspberry Pi with NixOS, starting simple and gradually increasing complexity through iterations.

## Milestones

### Milestone 1: Backup Current System ✅
**Goal:** Create a complete backup of the current Raspberry Pi SD card for disaster recovery.

**Status:** COMPLETED

**Completed Tasks:**
- ✅ Created complete SD card image backup (3.8GB compressed)
- ✅ Verified backup file exists
- ✅ Documented backup process
- ✅ Backup stored at: `raspberrypi-backup-20251107.img.gz`

---

### Milestone 2: Initial NixOS Boot with SSH Access ✅
**Goal:** Get NixOS installed and running with SSH access (critical since no external keyboard available).

**Status:** COMPLETED

**Completed Tasks:**
- ✅ Downloaded NixOS ARM aarch64 image (24.11.719113)
- ✅ Flashed SD card with NixOS
- ✅ Booted Pi successfully
- ✅ Established SSH connection

**Lessons Learned:**
- Default NixOS SD images are minimal and require initial setup
- Serial console (UART) configuration needed additional boot parameters
- HDMI capture card useful for troubleshooting headless setups
- SSH enabled by default but requires password to be set on first boot

---

### Milestone 3: Remote Access & First Service
**Goal:** Set up persistent remote access and deploy first real service.

**Tasks:**
- [ ] Install and configure Tailscale
  - Add to system configuration
  - Authenticate and join tailnet
  - Test access from remote location
- [ ] Set up Caddy reverse proxy
  - Basic Caddy configuration
  - SSL/TLS setup
  - Test reverse proxy functionality
- [ ] Deploy Home Assistant
  - NixOS Home Assistant service
  - Configure through Caddy
  - Verify access locally and through Tailscale

**Notes:**
- Tailscale provides secure access when away from home network
- Caddy handles HTTPS automatically with Let's Encrypt
- Start with simple, monolithic configuration

---

### Milestone 4: Structure & Best Practices (Iterative)
**Goal:** Gradually introduce better structure and reusable patterns as complexity grows.

**Phase 1 - Basic Structure:**
- [ ] Split configuration into logical files
  - `hardware-configuration.nix`
  - `networking.nix`
  - `services.nix`
- [ ] Use imports to organize

**Phase 2 - Reusable Modules:**
- [ ] Create custom modules for services
- [ ] Introduce proper option declarations
- [ ] Add module documentation

**Phase 3 - Advanced Patterns:**
- [ ] Secret management (sops-nix or agenix)
- [ ] Home Manager integration
- [ ] Flakes for dependency management
- [ ] Multiple machine configurations (if needed)

**Notes:**
- Don't over-engineer early
- Add structure only when it solves a real problem
- Each phase builds on previous learnings

---

## Future Milestones (To Be Defined)
- Additional services deployment
- Backup and disaster recovery automation
- Monitoring and observability
- Container orchestration (if needed)
- CI/CD for configuration updates

---

### Milestone 5: Development Environment (Optional)
**Goal:** Set up nix-darwin on macOS for consistent tooling and easier NixOS development.

**Tasks:**
- [ ] Install Nix package manager on macOS
- [ ] Set up nix-darwin configuration
- [ ] Configure development tools and shells
- [ ] Integrate with homelab workflow

**Benefits:**
- Consistent development environment
- Access to nix-shell for tasks like image flashing
- Better integration with NixOS configurations
- Declarative macOS configuration management

**Notes:**
- Completely optional - not required for homelab operation
- Can be done at any time
- Wolfgang's repo has darwin configurations to reference

---

## Current Status
**Active Milestone:** Milestone 3 - Remote Access & First Service

**Completed Milestones:**
- ✅ Milestone 1: Backup Current System
- ✅ Milestone 2: Initial NixOS Boot with SSH Access

**Next Steps:**
1. Copy initial-configuration.nix to the Pi
2. Install and configure Tailscale
3. Set up Caddy reverse proxy
4. Deploy Home Assistant

---

## Notes & Learnings
*This section will be updated as we progress through milestones*

### Hardware & Naming
- **Raspberry Pi (guinan)**:
  - Model: Raspberry Pi 3 B+
  - Previous OS: Raspbian (backed up)
  - Network setup: Ethernet, DHCP with router reservation
  - Hostname: guinan
- **Main Server (picard)**:
  - Hostname: picard
  - Will run standard homelab apps (Immich, Paperless-ngx, etc.)

### Backup Information
- Original SD card backed up: 2025-11-07
- Backup file: `raspberrypi-backup-20251107.img.gz`
- Compressed size: 3.8GB (from 32GB card)
- Restoration: `gunzip -c raspberrypi-backup-20251107.img.gz | sudo dd of=/dev/rdiskX bs=4m status=progress`

### NixOS Considerations
- ARM architecture requires specific images
- SD card flashing process differs from x86
- First-boot SSH is critical for headless setup
