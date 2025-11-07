# Raspberry Pi NixOS Setup Plan

## Overview
This plan outlines the progressive setup of a Raspberry Pi with NixOS, starting simple and gradually increasing complexity through iterations.

## Milestones

### Milestone 1: Backup Current System
**Goal:** Create a complete backup of the current Raspberry Pi SD card for disaster recovery.

**Tasks:**
- [ ] Create a complete SD card image backup
- [ ] Verify the backup can be restored
- [ ] Document the backup process
- [ ] Store backup in a safe location

**Notes:**
- Use `dd` or similar tool to create a complete disk image
- Test restoration on a separate SD card if available
- Keep backup accessible during NixOS setup

---

### Milestone 2: Initial NixOS Boot with SSH Access
**Goal:** Get NixOS installed and running with SSH access (critical since no external keyboard available).

**Tasks:**
- [ ] Download NixOS ARM image for Raspberry Pi
- [ ] Prepare SD card with NixOS
- [ ] Configure initial SSH access BEFORE first boot
  - Add SSH keys to the image
  - Enable SSH service in initial configuration
  - Set up known network configuration (WiFi or Ethernet)
- [ ] Flash SD card and perform first boot
- [ ] Verify SSH connectivity
- [ ] Create minimal initial configuration.nix
- [ ] Test applying new configurations remotely

**Critical Requirements:**
- SSH must work on first boot (no physical access to keyboard)
- Network connectivity must be established automatically
- SSH keys must be pre-configured

**Notes:**
- Consider using `nixos-generate` with proper config for ARM
- May need to mount the SD card and modify files before first boot
- Document the initial connection process (IP discovery, etc.)

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

## Current Status
**Active Milestone:** None yet - planning phase

**Next Steps:**
1. Review and adjust plan based on specific needs
2. Begin Milestone 1: Backup current system
3. Research NixOS ARM installation specifics

---

## Notes & Learnings
*This section will be updated as we progress through milestones*

### Raspberry Pi Specifics
- Model: (TBD)
- Current OS: (TBD)
- Network setup: (TBD)

### NixOS Considerations
- ARM architecture requires specific images
- SD card flashing process differs from x86
- First-boot SSH is critical for headless setup
