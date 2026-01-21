# NixOS Raspberry Pi Installation Guide

## Current Status

✅ NixOS is already installed on Guinan (Raspberry Pi)
⚠️ Cannot build configurations locally due to resource constraints (limited RAM/CPU)
🎯 **Next step:** Set up remote deployment from Riker using deploy-rs

## The Problem

Building NixOS configurations directly on the Raspberry Pi is impractical:
- Limited RAM causes out-of-memory errors during builds
- Slow CPU makes compilation extremely time-consuming
- `nixos-rebuild switch` fails or takes hours

## The Solution: Remote Deployment with deploy-rs

Build configurations on Riker (powerful x86_64 server), then deploy pre-built packages to Guinan over SSH.

**How it works:**
1. Riker evaluates Guinan's configuration for aarch64-linux
2. Riker builds packages (using binary caches, cross-compilation, or emulation)
3. Riker copies built packages to Guinan via SSH
4. Guinan activates the new configuration (fast, just switching symlinks)

## Setup Steps

### Step 1: Add Guinan Configuration to Flake

Add Guinan's configuration to `flake.nix`:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";
    deploy-rs.url = "github:serokell/deploy-rs";
  };

  outputs = { self, nixpkgs, deploy-rs, ... }: {
    nixosConfigurations = {
      riker = { ... };  # Existing

      guinan = nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        modules = [
          ./machines/guinan/configuration.nix
          ./machines/guinan/hardware-configuration.nix
          # Add common modules (tailscale, storage, etc)
        ];
      };
    };

    deploy.nodes.guinan = {
      hostname = "guinan.local";  # or IP address
      profiles.system = {
        user = "root";
        path = deploy-rs.lib.aarch64-linux.activate.nixos
               self.nixosConfigurations.guinan;
        sshUser = "leo";
        sudo = "sudo -u";
      };
    };
  };
}
```

### Step 2: Copy Hardware Configuration from Guinan

Guinan already has a generated hardware config. Copy it to the repo:

```bash
# From your Mac or Riker
ssh leo@guinan.local "sudo cat /etc/nixos/hardware-configuration.nix" > machines/guinan/hardware-configuration.nix
```

### Step 3: Create Guinan's Configuration

Create `machines/guinan/configuration.nix`:

```nix
{ config, pkgs, ... }:

{
  imports = [
    ./hardware-configuration.nix
    ../../modules/common.nix
    ../../modules/tailscale.nix
    # Add other modules as needed
  ];

  # Hostname
  networking.hostName = "guinan";

  # Storage tier (Pi has single disk)
  storage.tiers = {
    fast = "/var/lib";    # Pi uses standard paths
    normal = "/var/lib";
  };

  # Enable services
  services.home-assistant.enable = true;
  # ... other services

  system.stateVersion = "24.05";
}
```

### Step 4: Set Up SSH Access from Riker to Guinan

Ensure Riker can SSH into Guinan:

```bash
# On Riker, test SSH connection
ssh leo@guinan.local

# If needed, add Riker's SSH key to Guinan
ssh-copy-id leo@guinan.local

# Verify sudo works without password (required for deploy-rs)
ssh leo@guinan.local "sudo -n true" && echo "Sudo works!"
```

### Step 5: Deploy from Riker

```bash
# On Riker
cd /etc/nixos-config

# First build (will take time for cross-compilation/downloads)
nix run github:serokell/deploy-rs -- .#guinan

# Subsequent deployments will be faster (only changed packages)
```

## Build Strategy Details

**Binary caches** (fastest): Most packages already built for aarch64 at cache.nixos.org

**Cross-compilation**: If package not cached, Riker cross-compiles from x86_64 to aarch64

**Emulation** (slowest): Some packages require native ARM build, Riker uses QEMU emulation

## Troubleshooting

### Can't SSH from Riker to Guinan

```bash
# Check network connectivity
ssh leo@guinan.local

# Verify firewall allows SSH
# On Guinan, check SSH is running
systemctl status sshd
```

### Deploy fails with "cannot build derivation"

Some packages can't be cross-compiled. Options:
1. Use binary caches (add substituters)
2. Enable QEMU binfmt for native ARM emulation on Riker
3. Build those packages on a different ARM machine

### Out of disk space on Guinan

```bash
# On Guinan, clean old generations
sudo nix-collect-garbage --delete-older-than 7d

# On Riker, optimize before deploying
nix store optimise
```

## Alternative: Build from Your Mac

You can also build and deploy from your Mac instead of Riker:

```bash
# On your Mac
cd /path/to/nix-config
deploy .#guinan --hostname guinan.local
```

Same principle - powerful machine builds, Pi just receives and activates.

## Next Steps

Once deploy-rs is working:
- ✅ Deploy Home Assistant configuration
- ✅ Set up Caddy reverse proxy
- ✅ Configure Zigbee/Z-Wave integration
- ✅ Add to Tailscale network for remote access

## Historical Notes

**Initial Installation** (Already Complete):
- NixOS 24.11 SD image flashed to SD card
- Initial configuration copied before first boot
- SSH access configured with key-based auth
- Hardware configuration generated with `nixos-generate-config`
