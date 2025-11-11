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

# Clone configuration repository
echo "Cloning configuration repository..."
if [ -d /etc/nixos-config ]; then
  echo "Configuration already exists, updating..."
  cd /etc/nixos-config
  nix-shell -p git --run "git pull"
else
  nix-shell -p git --run "git clone https://github.com/leoweigand/nix /etc/nixos-config"
fi

# Deploy configuration
echo "Deploying NixOS configuration with flake..."
cd /etc/nixos-config
nix-shell -p git --run "nixos-rebuild switch --flake '.#$HOSTNAME'"

# It seems opnix intially fails one time to initialise, so the tailscale service needs to be restarted
systemctl restart tailscaled
systemctl restart tailscale-autoconnect.service

echo ""
echo "=== Setup Complete! ==="
echo "Tailscale should now be connected. Check with: tailscale status"
echo "SSH will be disabled on public IP. Use Tailscale to connect: ssh $HOSTNAME"
