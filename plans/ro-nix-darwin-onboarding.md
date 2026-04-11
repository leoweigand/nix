# ro: nix-darwin Onboarding

Incrementally bring the personal MacBook (`leo-macbook`, arm64, macOS 15.5) into this flake as `darwinConfigurations.ro`.

**Constraints:**
- No big-bang migration — each phase should leave the machine in a working state
- Hostname stays `leo-macbook`; `ro` is only the flake attribute name
- Personal profile only for now
- chezmoi dotfiles continue working throughout; nothing is removed from there until nix-darwin fully owns it

---

## Phase 1 — Minimal skeleton ✅

Goal: `darwin-rebuild switch --flake .#ro` works end-to-end with no conflicts.

### Delivered
- `machines/ro/configuration.nix` — minimal system config
- Updated `flake.nix` — `nix-darwin` + `home-manager` inputs, `darwinConfigurations.ro` output

### Key implementation notes

**`inputs.nixpkgs.follows`** on both `nix-darwin` and `home-manager` — they reuse the repo's nixpkgs pin, one eval, no version mismatches.

**`home-manager.darwinModules.home-manager`** wires HM as a nix-darwin module so `darwin-rebuild switch` drives everything; `home-manager switch` is never needed separately.

**`useGlobalPkgs = true`** — HM reuses the system nixpkgs instance (faster builds, consistent versions).

**`useUserPackages = true`** — HM packages land in `/etc/profiles/per-user/leo/` rather than `~/.nix-profile`, avoiding PATH conflicts.

**`users.users.leo.home = "/Users/leo"`** — nix-darwin's `users.users.<name>.home` defaults to `null`; home-manager's common module reads this to set `home.homeDirectory`, so it must be set on the nix-darwin side explicitly.

### First-time activation gotchas
- New files must be `git add`-ed (and ideally committed) before `nix run nix-darwin` sees them — nix reads the git object store.
- `/etc/bashrc` (and possibly `/etc/zshrc`) must be renamed to `*.before-nix-darwin` before activation; nix-darwin refuses to overwrite unrecognized content in `/etc`.
- Bootstrap command (before `darwin-rebuild` is in PATH):
  ```bash
  sudo nix --extra-experimental-features 'nix-command flakes' run nix-darwin -- switch --flake /path/to/repo#ro
  ```
- Day-to-day after first activation: `darwin-rebuild switch --flake .#ro`

---

## Phase 2 — Shared Home Manager modules + first programs ✅ (zellij done)

Goal: install and configure new tools (not migrated from chezmoi) declaratively, shared between ro and picard.

### Approach
Create `modules/home/` — a cross-platform Home Manager module directory imported by both machines.

```
modules/
  home/
    default.nix     # imports all home modules
    zellij.nix      # first shared program
```

**Adding HM to picard** — picard currently has no Home Manager; packages live in `environment.systemPackages`. Wire in HM via `home-manager.nixosModules.home-manager` (same pattern as ro but for NixOS), then have it import `modules/home`.

**Wiring into ro** — add `imports = [ ../../modules/home ];` inside `home-manager.users.leo` in `machines/ro/configuration.nix`.

### Zellij
Home Manager has a first-class `programs.zellij` module. Config goes in `modules/home/zellij.nix`:
```nix
programs.zellij = {
  enable = true;
  settings = { ... };
};
```

### What this phase does NOT touch
- Homebrew / Brewfile
- macOS system defaults
- Migrating anything from chezmoi

---

## Phase 3 — macOS system defaults (sketch)

Move the `defaults write` commands from chezmoi's `run_once_after_setup-macos-defaults.sh.tmpl` into nix-darwin's `system.defaults.*` options.

- Trackpad scaling, key repeat, initial key repeat delay
- Dock: autohide delay, minimize-to-application, hide recent apps
- Retire or gut the chezmoi run-once script once nix-darwin owns these (nix-darwin re-applies on every switch, so no drift)

---

## Phase 4 — Homebrew packages (sketch)

Replace the chezmoi Brewfile + run-once install script with nix-darwin's `homebrew` module (or `nix-homebrew`).

- `homebrew.brews` replaces `brew "..."` entries
- `homebrew.casks` replaces `cask "..."` entries
- `homebrew.onActivation.autoUpdate` / `cleanup` for hygiene
- Remove `dot_config/homebrew/` and the chezmoi brew install script
- Note: profiling (`work` vs `personal`) would need a different mechanism here since chezmoi templates won't apply — could use a separate machine config or a NixOS-style option

---

## Phase 5 — Home Manager: programs (sketch)

Migrate individual programs from chezmoi into Home Manager, one at a time. Good candidates in roughly increasing order of complexity:

- `git` — HM has a first-class module, simple to migrate
- `zsh` — shell config, aliases, env vars; HM module is solid
- `starship` — trivial, single config file
- `tmux` — moderate; HM module handles plugin management too
- `ghostty` / `zed` — raw file passthrough if no HM module exists, still declarative
- `neovim` — biggest lift; HM has a good module but config is large; do last or keep in chezmoi

Approach: migrate one program at a time, remove from chezmoi, verify nothing breaks. Once everything is migrated, retire chezmoi entirely.

---

## Phase 6 — System packages via Nix (sketch)

Move CLI tools currently installed via Homebrew (`neovim`, `ripgrep`, `bat`, `zoxide`, `fzf`, etc.) into `environment.systemPackages` or `home.packages` (Home Manager).

- Prefer `home.packages` for user-facing CLI tools
- Keep casks in Homebrew (Nix can't manage GUI apps on macOS well)
- Fonts: nix-darwin has `fonts.packages` — can replace font casks

---

## Open questions / decisions deferred

- **Work profile**: if this machine ever needs a work profile, options are a separate `darwinConfigurations.ro-work`, a NixOS-style boolean option, or just a separate branch. Not needed now.
- **Secrets on macOS**: opnix is Linux-only. If this machine needs secrets (e.g. API keys for scripts), we'll need a different mechanism — 1Password CLI is already installed, could use that directly.
- **nix-homebrew vs built-in**: nix-darwin's built-in `homebrew` module is simpler; `nix-homebrew` gives more control over the Homebrew installation itself. Decide in Phase 3.
