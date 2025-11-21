#!/usr/bin/env bash
set -e

# NixOS Setup Script
# Usage: curl -sSL https://raw.githubusercontent.com/leoweigand/nix/main/setup.sh | OPNIX_TOKEN=ops_xxx HOSTNAME=riker bash

echo "=== NixOS Configuration Setup ==="

# Check for required environment variables
if [ -z "$OPNIX_TOKEN" ]; then
  echo "ERROR: OPNIX_TOKEN environment variable is required"
  echo "Usage: curl -sSL https://raw.githubusercontent.com/leoweigand/nix/main/setup.sh | OPNIX_TOKEN=ops_xxx HOSTNAME=riker bash"
  exit 1
fi

if [ -z "$HOSTNAME" ]; then
  echo "ERROR: HOSTNAME environment variable is required (e.g., riker or picard)"
  exit 1
fi

echo "Setting up host: $HOSTNAME"

# Create 1Password token file
echo "Creating 1Password token file..."
echo "$OPNIX_TOKEN" | tee /etc/opnix-token > /dev/null
chmod 600 /etc/opnix-token
chown root:root /etc/opnix-token

# Clone configuration repository using nix run to get git
echo "Cloning configuration repository..."
if [ -d /etc/nixos-config ]; then
  echo "Configuration already exists, updating..."
  cd /etc/nixos-config
  nix --extra-experimental-features "nix-command flakes" run nixpkgs#git -- pull
else
  nix --extra-experimental-features "nix-command flakes" run nixpkgs#git -- clone https://github.com/leoweigand/nix /etc/nixos-config
fi

# Deploy configuration
echo "Deploying NixOS configuration with flake..."
cd /etc/nixos-config

# Ensure git is in the environment for nixos-rebuild (flakes need it)
export PATH="$(nix --extra-experimental-features "nix-command flakes" build --no-link --print-out-paths nixpkgs#git)/bin:$PATH"

nixos-rebuild switch --extra-experimental-features "nix-command flakes" --flake ".#$HOSTNAME"

echo ""
echo "=== Setup Complete! ==="
echo "Rebooting to fully initialize opnix secrets and Tailscale..."
echo "After reboot:"
echo "  - Tailscale will be connected (check: tailscale status)"
echo "  - SSH on public IP will be disabled"
echo "  - Connect via Tailscale: ssh $HOSTNAME"
echo ""
echo "Rebooting in 5 seconds..."
sleep 5
reboot
