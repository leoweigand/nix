#!/usr/bin/env bash
set -euo pipefail

machine="${1:-$(cat /etc/nix-machine 2>/dev/null || true)}"
if [[ -z "$machine" ]]; then
  echo "usage: $0 <darwin-machine>" >&2
  exit 2
fi

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$repo_dir#darwinConfigurations.$machine.system"
plan_file="$(mktemp -t nix-darwin-build-plan.XXXXXX)"
trap 'rm -f "$plan_file"' EXIT

echo "Checking $target"
nix build "$target" --dry-run 2>&1 | tee "$plan_file"

# nix-darwin and Home Manager always create small host-specific files locally.
# Compiler/toolchain derivations in the plan are the useful early warning that
# a third-party package has fallen off the binary-cache path.
heavy_pattern='-(cargo|clang|cmake|gcc|ghc|go|llvm|meson|ninja|rustc|rust-std|zig)(-|[.])'
local_builds="$(awk '
  /derivations will be built:/ { in_builds = 1; next }
  /paths will be fetched/ { in_builds = 0 }
  in_builds && /\.drv$/ { print }
' "$plan_file")"

if grep -E -- "$heavy_pattern" <<<"$local_builds" >/dev/null; then
  echo >&2
  echo "Refusing build plan: a compiler or build tool would be built locally." >&2
  echo "Choose a cached package, upstream binary, Homebrew package, or an explicit exception." >&2
  exit 1
fi

echo
echo "No locally built compiler or build-tool derivations detected."
