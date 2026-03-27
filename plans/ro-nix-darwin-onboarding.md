# ro: nix-darwin Onboarding

Incrementally bring the personal MacBook (`leo-macbook`, arm64, macOS 15.5) into this flake as `darwinConfigurations.ro`.

**Constraints:**
- No big-bang migration — each phase should leave the machine in a working state
- Hostname stays `leo-macbook`; `ro` is only the flake attribute name
- Personal profile only for now
- chezmoi dotfiles continue working throughout; nothing is removed from there until nix-darwin fully owns it

---

## Phase 1 — Minimal skeleton (current focus)

Goal: `darwin-rebuild switch --flake .#ro` works end-to-end with no conflicts.

### Flake changes
- Add `nix-darwin` input: `github:LnL7/nix-darwin/master`
- Add `home-manager` input: `github:nix-community/home-manager` (follows nixpkgs)
- Add `darwinConfigurations.ro` output using `nix-darwin.lib.darwinSystem`
- System: `aarch64-darwin`

### machines/ro/configuration.nix
Minimal system config only:
- `nixpkgs.hostPlatform = "aarch64-darwin"`
- `system.stateVersion = 5`
- Nix settings: `nix.settings.experimental-features = ["nix-command" "flakes"]`
- Timezone and locale
- Wire in Home Manager as a nix-darwin module (empty `home-manager.users.leo` block)
- `networking.hostName` left unset (keeping `leo-macbook`)

### What this phase does NOT touch
- Homebrew / Brewfile
- macOS system defaults
- Any dotfiles or programs

### Delivery
- `machines/ro/configuration.nix`
- Updated `flake.nix`

---

## Phase 2 — macOS system defaults (sketch)

Move the `defaults write` commands from chezmoi's `run_once_after_setup-macos-defaults.sh.tmpl` into nix-darwin's `system.defaults.*` options.

- Trackpad scaling, key repeat, initial key repeat delay
- Dock: autohide delay, minimize-to-application, hide recent apps
- Retire or gut the chezmoi run-once script once nix-darwin owns these (nix-darwin re-applies on every switch, so no drift)

---

## Phase 3 — Homebrew packages (sketch)

Replace the chezmoi Brewfile + run-once install script with nix-darwin's `homebrew` module (or `nix-homebrew`).

- `homebrew.brews` replaces `brew "..."` entries
- `homebrew.casks` replaces `cask "..."` entries
- `homebrew.onActivation.autoUpdate` / `cleanup` for hygiene
- Remove `dot_config/homebrew/` and the chezmoi brew install script
- Note: profiling (`work` vs `personal`) would need a different mechanism here since chezmoi templates won't apply — could use a separate machine config or a NixOS-style option

---

## Phase 4 — Home Manager: programs (sketch)

Migrate individual programs from chezmoi into Home Manager, one at a time. Good candidates in roughly increasing order of complexity:

- `git` — HM has a first-class module, simple to migrate
- `zsh` — shell config, aliases, env vars; HM module is solid
- `starship` — trivial, single config file
- `tmux` — moderate; HM module handles plugin management too
- `ghostty` / `zed` — raw file passthrough if no HM module exists, still declarative
- `neovim` — biggest lift; HM has a good module but config is large; do last or keep in chezmoi

Approach: migrate one program at a time, remove from chezmoi, verify nothing breaks. Once everything is migrated, retire chezmoi entirely.

---

## Phase 5 — System packages via Nix (sketch)

Move CLI tools currently installed via Homebrew (`neovim`, `ripgrep`, `bat`, `zoxide`, `fzf`, etc.) into `environment.systemPackages` or `home.packages` (Home Manager).

- Prefer `home.packages` for user-facing CLI tools
- Keep casks in Homebrew (Nix can't manage GUI apps on macOS well)
- Fonts: nix-darwin has `fonts.packages` — can replace font casks

---

## Open questions / decisions deferred

- **Work profile**: if this machine ever needs a work profile, options are a separate `darwinConfigurations.ro-work`, a NixOS-style boolean option, or just a separate branch. Not needed now.
- **Secrets on macOS**: opnix is Linux-only. If this machine needs secrets (e.g. API keys for scripts), we'll need a different mechanism — 1Password CLI is already installed, could use that directly.
- **nix-homebrew vs built-in**: nix-darwin's built-in `homebrew` module is simpler; `nix-homebrew` gives more control over the Homebrew installation itself. Decide in Phase 3.
