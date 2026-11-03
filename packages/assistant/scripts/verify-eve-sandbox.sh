#!/usr/bin/env bash
# Run on Picard, with a built assistant output, patched landrun and packaged Node.
# This creates only private scratch directories and one transient test service.
set -euo pipefail
if [[ $# -ne 3 ]]; then
  echo "Usage: $0 /nix/store/...-leolab-assistant /nix/store/...-landrun/bin/landrun /nix/store/...-nodejs/bin/node" >&2
  exit 2
fi
package=$1
landrun=$2
node=$3
[[ "$package" == /nix/store/* && -f "$package/lib/leolab-assistant/.output/server/index.mjs" ]]
[[ "$landrun" == /nix/store/* && -x "$landrun" && "$node" == /nix/store/* && -x "$node" ]]
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
native=$(sudo -n mktemp -d /var/lib/.eve-sandbox-check.XXXXXX)
shared=""
unit=""
cleanup() {
  if [[ -n "$unit" ]]; then sudo -n systemctl stop "$unit" >/dev/null 2>&1 || true; fi
  sudo -n rm -rf -- "$native"
  if [[ -n "$shared" ]]; then sudo -n rm -rf -- "$shared"; fi
}
trap cleanup EXIT
shared=$(sudo -n mktemp -d /mnt/fast/appdata/.eve-sandbox-check.XXXXXX)
sudo -n chown leolab-assistant:leolab-assistant "$native" "$shared"
for file in eve-sandbox-preload.mjs eve-sandbox-run.mjs eve-sandbox-engine.sh; do
  sudo -n install -m 0755 "$script_dir/$file" "$native/$file"
done
unit="eve-sandbox-check-$(date +%s)-$$"
echo "Checking $package in transient unit $unit; private request state on virtiofs and workflow state on native storage."
sudo -n systemd-run --unit="$unit" --wait --pipe --collect \
  -p User=leolab-assistant -p Group=leolab-assistant -p "WorkingDirectory=$native" \
  -p MemoryMax=1024M -p TasksMax=64 -p UMask=0077 -p TimeoutStopSec=20s \
  -p NoNewPrivileges=yes -p PrivateDevices=yes -p PrivateTmp=yes -p PrivateNetwork=yes \
  -p ProtectSystem=strict -p ProtectHome=yes -p ProtectKernelTunables=yes \
  -p ProtectKernelModules=yes -p ProtectControlGroups=yes \
  -p 'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX' -p RestrictNamespaces=yes \
  -p RestrictRealtime=yes -p SystemCallArchitectures=native \
  -p "ReadWritePaths=$native $shared" \
  -p 'InaccessiblePaths=-/mnt/fast/appdata/leolab-assistant -/var/lib/leolab-assistant-eve -/var/lib/leolab-assistant-instructions' \
  --setenv="EVE_CHECK_PACKAGE=$package" --setenv="EVE_CHECK_LANDRUN=$landrun" --setenv="EVE_CHECK_NODE=$node" \
  --setenv="EVE_SANDBOX_ROOT=$native" --setenv="EVE_SANDBOX_REQUEST_TMPDIR=$shared" \
  --setenv="EVE_SANDBOX_ENGINE_LAUNCHER=$native/eve-sandbox-engine.sh" \
  --setenv="TMPDIR=$native/tmp" --setenv="EVE_TEST_ENGINE_TMPDIR=$native/workflow" \
  "$node" "$native/eve-sandbox-run.mjs"
