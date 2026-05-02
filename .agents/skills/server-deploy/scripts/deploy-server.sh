#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <server>"
  echo "Allowed servers: picard"
  exit 1
fi

server="$1"

case "$server" in
  picard) ;;
  *)
    echo "Error: server '$server' is not allowlisted."
    echo "Allowed servers: picard"
    exit 1
    ;;
esac

echo "==> Deploy target: $server"
echo "==> Local context: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'detached')@$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown') (working tree, may include uncommitted changes)"

# Eval locally (works on darwin since eval is platform-independent), ship the
# derivation graph to $server over SSH, build there, then activate. No GitHub
# round-trip, no /opt/nixos-config checkout needed on the target.
echo "==> Building and activating on $server"
nix run nixpkgs#nixos-rebuild -- switch \
  --flake ".#$server" \
  --build-host "$server" \
  --target-host "$server" \
  --sudo

echo "==> Deploy complete for $server"
