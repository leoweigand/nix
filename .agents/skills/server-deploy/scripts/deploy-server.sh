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

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit, stash, or discard all changes first."
  exit 1
fi

branch="$(git branch --show-current)"
commit="$(git rev-parse --short HEAD)"

if [[ -z "$branch" ]]; then
  echo "Error: unable to determine current branch."
  exit 1
fi

if ! git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
  echo "Error: current branch '$branch' has no upstream tracking branch."
  echo "Set one first, for example: git push -u origin $branch"
  exit 1
fi

echo "==> Deploy target: $server"
echo "==> Local context: branch=$branch commit=$commit"

echo "==> Pushing local branch to tracked remote"
git push

echo "==> Running remote deploy on $server"
ssh "$server" "set -euo pipefail; cd ~/nixos-config; git pull --ff-only; sudo nixos-rebuild switch --flake .#$server"

echo "==> Deploy complete for $server"
echo "==> Applied commit: $commit from branch $branch"
