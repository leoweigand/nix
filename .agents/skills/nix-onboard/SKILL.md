---
name: nix-onboard
description: Onboard a CLI/GUI tool into this nix flake — add a home-manager module under modules/home/, scope it to the right machines, and remove the old non-nix install. Use when the user says "onboard X to nix", "manage X via nix", or wants to migrate a tool they installed manually (brew, apt, curl|sh, etc.).
---

# Onboard a tool into nix

Migrate a tool from manual install (brew, apt, curl|sh, etc.) to declarative management via this flake.

## Steps

### 1. Pick the scope

If the tool is currently installed on this mac, it's going onto `ro` regardless — the only decision is whether it *also* belongs on the nixos server(s).

- **mac-only** — UI apps, dev workstation tools, anything irrelevant to a headless server. Default here.
- **mac + nixos (picard)** — server-relevant CLI/ops tools (zellij, fzf, ripgrep, jq, restic helpers, etc.).

`modules/home/` is imported by both `machines/ro` (darwin) and `modules/users/leo` (picard), so anything added there lands on every host. For mac-only tools, gate with `lib.mkIf pkgs.stdenv.isDarwin` inside the module.

### 2. Prefer `programs.<tool>` over `home.packages`

Home-manager has first-class modules for many tools (`programs.zellij`, `programs.git`, `programs.fzf`, …). These manage both the package and config declaratively. Check first:

```bash
nix-instantiate --eval -E 'with import <nixpkgs> {}; builtins.attrNames (import <home-manager/modules> { inherit pkgs lib; config = {}; }).config.programs' 2>/dev/null
```

Or just search the home-manager options site. Fall back to `home.packages = [ pkgs.<tool> ];` only when no module exists.

### 3. Add the module

Create `modules/home/<tool>.nix` following the `modules/home/zellij.nix` shape — minimal, commented only where non-obvious (see project AGENTS.md comment policy). Then add it to `modules/home/default.nix`:

```nix
imports = [
  ./zellij.nix
  ./<tool>.nix
];
```

For nixos-only or darwin-only behavior, gate with `lib.mkIf pkgs.stdenv.isLinux` / `isDarwin` inside the module.

### 4. Build locally before deploying

On the machine you're targeting (or via the dev shell):

```bash
# darwin (ro)
darwin-rebuild build --flake /Users/leo/git/nix#ro

# nixos (picard) — use the server-deploy skill, don't rebuild remotely from here
```

Don't switch yet — the old install is still on PATH and may conflict.

### 5. Remove the old install

**Critical: do this only after the nix build succeeds.** Otherwise you're left with no working tool.

Common removal commands (pick what applies):

```bash
brew uninstall <tool>          # Homebrew formula
brew uninstall --cask <tool>   # Homebrew cask
rm -rf ~/.local/bin/<tool>     # curl|sh installs
rm -rf /opt/<tool>             # vendor installers
sudo apt remove <tool>         # debian (rare in this repo)
```

Also clear stale config that the home-manager module will now own (e.g. `~/.config/<tool>/config.toml`) — but back it up first if it has user state. Many `programs.*` modules write to the same path and will clobber it; verify by checking the module's `config` output before deleting anything irreplaceable.

### 6. Switch and verify

```bash
darwin-rebuild switch --flake /Users/leo/git/nix#ro
which <tool>           # should resolve to /etc/profiles/per-user/leo/bin/<tool> or /run/current-system/sw/bin/<tool>
<tool> --version       # sanity check
```

For nixos machines, hand off to the `server-deploy` skill after committing.

## Reference

- `modules/home/zellij.nix` — clean example of a `programs.*` module with settings.
- Wolfgang's repo at `/Users/leo/git/untrusted/notthebee-nix` — look here for tool patterns when unsure.
