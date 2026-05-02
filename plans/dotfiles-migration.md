# Migrate `~/git/dotfiles` (chezmoi) into nix

Bring the rest of the personal Mac (`ro`) configuration out of [chezmoi](https://chezmoi.io) and into this flake, one tool at a time. Each task should leave the machine in a working state — chezmoi keeps owning everything that hasn't been migrated yet, and items only get deleted from `~/git/dotfiles` once nix-darwin/home-manager fully owns them.

This plan supersedes the unfinished phases (3-6) of [`ro-nix-darwin-onboarding.md`](./ro-nix-darwin-onboarding.md), broken into smaller, individually shippable units.

---

## Status: what's already in nix

Already managed by `modules/home/common/`:
- bat, gh, ripgrep, ffmpeg (`cli.nix`)
- fzf, lazygit, neovim (enabled, no config), opencode, starship (basic), zellij, zoxide

Everything else still lives in `~/git/dotfiles` under chezmoi. Inventory of what remains:

| Source in dotfiles | Kind | Migration target |
|---|---|---|
| `run_once_after_setup-macos-defaults.sh.tmpl` | macOS defaults | `system.defaults.*` (nix-darwin) |
| `dot_config/homebrew/Brewfile.tmpl` | brew + cask packages | `homebrew.brews` / `homebrew.casks` (nix-darwin) |
| `dot_gitconfig.tmpl` | git config | `programs.git` (HM) |
| `dot_config/zsh/**`, `dot_zshenv` | zsh + plugins + tools | `programs.zsh` (HM) |
| `dot_config/tmux/**`, `tmux/tmux.conf`, `.chezmoiexternal.toml` (tpm) | tmux | delete — not migrating, dropping tmux entirely |
| `dot_config/ghostty/config` | terminal config | `xdg.configFile` passthrough or `programs.ghostty` if available |
| `dot_config/zed/settings.json` | editor config | `programs.zed-editor` (HM) or file passthrough |
| `dot_config/gh/config.yml` | gh CLI config | `programs.gh.settings` (HM) |
| `dot_config/nvim/**` (AstroNvim) | neovim config | file passthrough first; deeper nix integration optional later |
| `dot_hushlogin` | empty marker file | `home.file.".hushlogin"` |
| Fonts (JetBrains Mono Nerd Font, iA Writer Quattro) | fonts | nix-darwin `fonts.packages` (where pkgs exist) |

---

## Ordering principle

Smallest blast radius first. Group: macOS defaults and packages (system-level) → small isolated configs (gh, zed, ghostty) → shell ecosystem (git, then zsh) → neovim last. Each task ends with **deleting the chezmoi-side file** so the source of truth never drifts.

---

## Tasks

- [x] 0. Preflight: chezmoi is clean
- [x] 1. macOS system defaults
- [x] 2. Homebrew packages (casks + brews)
- [x] 3. Fonts
- [x] 4. `gh` CLI config
- [x] 5. git config
- [x] 6. zsh + plugins + shell tools
- [x] 7. Drop tmux
- [x] 8. Ghostty config
- [x] 9. Zed editor settings
- [x] 10. Misc small files
- [x] 11. Neovim
- [x] 12. Retire chezmoi

---

### 0. Preflight: chezmoi is clean ✅

Before touching anything, make sure the chezmoi source and the live `$HOME` are in sync. Migrating while there are pending diffs risks losing local edits or re-introducing stale config.

```bash
chezmoi status   # should print nothing
chezmoi diff     # should be empty
cd ~/git/dotfiles && git status   # working tree clean, nothing unpushed that matters
```

Resolve anything that shows up:
- **`chezmoi status` shows `M`/`A`** (live file ahead of source): inspect with `chezmoi diff`. If the live edit is desired, `chezmoi re-add <path>` to pull it back into the source. If not, `chezmoi apply <path>` to overwrite the live file.
- **Source ahead of live** (modifications in `~/git/dotfiles` not yet applied): `chezmoi apply` after reviewing the diff.
- **Untracked files in `~/git/dotfiles`**: commit, ignore via `.chezmoiignore`, or delete.

**Done when:** `chezmoi status` and `chezmoi diff` are both empty, and `git status` in `~/git/dotfiles` is clean.

---

### 1. macOS system defaults

Move the `defaults write` commands from `run_once_after_setup-macos-defaults.sh.tmpl` into `machines/ro/configuration.nix` under `system.defaults.*`.

- `system.defaults.NSGlobalDomain.AppleKeyboardUIMode = 3;`
- `system.defaults.NSGlobalDomain.InitialKeyRepeat = 12;`
- `system.defaults.NSGlobalDomain.KeyRepeat = 2;`
- `system.defaults.NSGlobalDomain."com.apple.trackpad.scaling" = 7.0;`
- `system.defaults.dock.autohide-delay = 0.0;`
- `system.defaults.dock.minimize-to-application = true;`
- `system.defaults.dock.show-recents = false;`

Verify with `defaults read` after `darwin-rebuild switch`. nix-darwin re-applies on every switch, so chezmoi's run-once script can be deleted afterward.

**Done when:** chezmoi `run_once_after_setup-macos-defaults.sh.tmpl` is removed and a fresh `darwin-rebuild switch` reproduces the same `defaults` values.

---

### 2. Homebrew packages (casks + brews)

Replace `dot_config/homebrew/Brewfile.tmpl` and the `run_onchange_after_install-brew-packages.sh.tmpl` runner with nix-darwin's built-in `homebrew` module. Keep brew installation itself (the `brew` binary in `/opt/homebrew/bin/brew`) — nix-darwin uses it.

```nix
homebrew = {
  enable = true;
  onActivation = {
    autoUpdate = true;
    upgrade = true;
    cleanup = "zap";  # remove anything not declared
  };
  brews = [ ];
  casks = [
    "ghostty" "raycast" "obsidian" "1password-cli" "zed" "macwhisper"
    "tailscale-app"
  ];
  masApps = { };
};
```

Brew formulae from the current Brewfile that should NOT be migrated to homebrew:
- `starship`, `neovim`, `lazygit`, `ripgrep`, `zoxide`, `bat`, `gh`, `ffmpeg`, `fzf` — already in nix or replaced by HM modules
- `tmux` — dropped entirely (Task 7)
- `antidote` — replaced by HM `programs.zsh.plugins` (Task 6)
- `nvm` — replaced by HM `programs.fnm` (Task 6)

Casks are the right place for GUI apps (Nix can't manage `.app` bundles well on macOS). Fonts move to Task 3.

**Done when:** `brew bundle dump` matches the declared list and `dot_config/homebrew/` + the chezmoi run-onchange script are deleted.

---

### 3. Fonts

Move `font-jetbrains-mono-nerd-font` and `font-ia-writer-quattro` from Brewfile casks to nix where possible.

- `pkgs.nerd-fonts.jetbrains-mono` exists in nixpkgs and works on darwin via `fonts.packages` in nix-darwin.
- iA Writer Quattro is a proprietary font from iA — likely no nixpkgs derivation. Keep it as a cask (`homebrew.casks`).

**Done when:** JetBrains Mono comes from nix; the cask line is removed from the Brewfile migration.

---

### 4. `gh` CLI config

Smallest config in dotfiles — good warm-up for HM passthrough.

```nix
# modules/home/common/gh.nix
programs.gh.settings = {
  git_protocol = "ssh";
  prompt = "enabled";
  aliases.co = "pr checkout";
};
```

`programs.gh` is already implicitly enabled via `home.packages` in `cli.nix` — switch to the explicit module: `programs.gh.enable = true;` in the same file, drop `gh` from `home.packages`.

**Done when:** `dot_config/gh/config.yml` removed; `gh auth status` still works (auth is in keychain, not the YAML).

---

### 5. git config

```nix
# modules/home/common/git.nix
programs.git = {
  enable = true;
  userName = "Leo Weigand";
  userEmail = "5489276+leoweigand@users.noreply.github.com";
  extraConfig = {
    push.default = "current";
    pull.ff = "only";
    url."git@github.com:".insteadOf = "https://github.com/";
  };
};
```

The chezmoi template parameterised `name` per machine — both machines we have today use the same identity, so hardcode for now. If/when a work profile shows up, lift name/email into a per-machine override.

**Done when:** `dot_gitconfig.tmpl` removed; `git config --get user.email` returns the noreply address.

---

### 6. zsh + plugins + shell tools

Largest non-neovim migration. Approach: stand up `programs.zsh` in HM, port one section at a time, leave chezmoi's `dot_zshrc` in place but **stop sourcing it** once HM owns the shell.

`dot_zshenv` becomes redundant — HM defaults to `ZDOTDIR=~`, no need for `~/.config/zsh` unless we want it; pick whichever is simpler (default to HM's location).

Sections to port:

- **`env.zsh`** → `home.sessionPath` for the `~/.lmstudio/bin`, `~/.local/bin`, `~/.opencode/bin` PATH entries. Drop the `brew shellenv` line — HM/nix-darwin already adds `/opt/homebrew/bin` to `PATH`.
- **`aliases.zsh`** → `programs.zsh.shellAliases`.
- **`functions.zsh`** (`web-convert`) → `programs.zsh.initContent` or a plain function file via `home.file`.
- **`completions.zsh`** → most of this is HM defaults; the `zstyle` lines go in `programs.zsh.initContent`.
- **`tools.zsh.tmpl`** → mostly redundant once HM modules are wired:
  - `starship init` — already handled by `programs.starship.enableZshIntegration` (default true).
  - `zoxide init` — already handled by `zoxide.nix`.
  - `fzf` keybindings — handled by `programs.fzf.enableZshIntegration`.
  - `antidote` → `programs.zsh.plugins` (HM-native, drop antidote entirely). Plugins to keep, sourced from `pkgs`:
    - `zsh-users/zsh-completions` → `pkgs.zsh-completions`
    - `zsh-users/zsh-autosuggestions` → `pkgs.zsh-autosuggestions`
    - `zsh-users/zsh-syntax-highlighting` → `pkgs.zsh-syntax-highlighting`
  - `nvm` → `programs.fnm` (HM-native; drop-in for nvm with auto-switching via `.nvmrc`/`.node-version`). Set `programs.fnm.enableZshIntegration = true` and `programs.fnm.settings.node_dist_mirror` if needed; otherwise defaults are fine.
  - Pre-populated zoxide entries — `programs.zoxide` doesn't have a first-class option for this; handle via a one-shot activation script or drop (zoxide learns fast anyway).

**Done when:** all `dot_config/zsh/*` and `dot_zshenv` are removed; `chezmoi apply` no longer touches the shell; opening a fresh terminal gives identical behaviour (prompt, aliases, completions, plugins).

---

### 7. Drop tmux

Not migrating to nix — dropping tmux entirely. Just delete the chezmoi-side files.

- Delete `dot_config/tmux/` from `~/git/dotfiles`
- Delete `tmux/tmux.conf` from `~/git/dotfiles`
- Remove the tpm entry from `.chezmoiexternal.toml` (or delete the file if tpm is the only entry)
- Uninstall tmux from brew (it will also be absent from the Task 2 Brewfile migration)

**Done when:** no tmux config remains in chezmoi; `tmux` is not installed.

---

### 8. Ghostty config

No first-class HM module for Ghostty in stable nixpkgs — passthrough is the simplest path:

```nix
# modules/home/darwin/ghostty.nix
xdg.configFile."ghostty/config".source = ./ghostty-config;
```

Keep this Mac-only since Ghostty is a cask.

**Done when:** `dot_config/ghostty/` removed; opening Ghostty still uses JetBrains Mono + sonokai theme.

---

### 9. Zed editor settings

HM has `programs.zed-editor` on unstable. Either use it:

```nix
programs.zed-editor = {
  enable = false;  # zed itself comes from homebrew cask
  userSettings = {
    vim_mode = true;
    ui_font_size = 16;
    buffer_font_size = 15;
    theme = { mode = "system"; light = "One Light"; dark = "One Dark"; };
  };
};
```

…or just write `home.file."Library/Application Support/Zed/settings.json"`. The module is fine even with `enable = false` since the package comes from the cask.

**Done when:** `dot_config/zed/` removed; Zed still opens with vim mode + theme.

---

### 10. Misc small files

- **`dot_hushlogin`** → `home.file.".hushlogin".text = "";` (or just `programs.zsh.initContent` to print nothing — but `.hushlogin` is the canonical mechanism).

**Done when:** chezmoi has no top-level files left except whatever neovim still owns.

---

### 11. Neovim (last, biggest)

The current setup is AstroNvim (cloned config) under `dot_config/nvim/`. Two paths:

- **Path A — passthrough (low risk):** `xdg.configFile."nvim".source = ./nvim;` and copy the whole tree into the nix repo. Leaves AstroNvim's plugin manager (lazy.nvim) in charge of plugins. Easiest migration; loses none of the existing config.
- **Path B — `programs.neovim` with declarative plugins (high effort):** lift each plugin into `programs.neovim.plugins`, manage LSPs through nix. Loses LazyVim's auto-update flow but gains reproducibility.

Recommendation: **Path A first**, defer Path B to a separate plan if we ever want it. Keep `programs.neovim.enable = true` to install neovim itself, and replace the plugin-manager-driven `init.lua` only if/when we tackle Path B.

**Done when:** `dot_config/nvim/` removed from chezmoi; `nvim` opens AstroNvim from the path managed by HM.

---

### 12. Retire chezmoi

Once the table at the top is empty:

- Delete the `~/git/dotfiles` repo (or archive it).
- Remove `chezmoi` from anywhere it's referenced (currently `.setup.sh` brew-installs it — that script becomes obsolete when `setup.sh` for nix takes over).
- Update the README of this repo to mention that `ro` is bootstrapped via `darwin-rebuild`, not chezmoi.

**Done when:** `chezmoi` binary can be uninstalled with no functional change.

---

## Decisions

- **Node version manager**: replace `nvm` with fnm (`pkgs.fnm` + manual `eval "$(fnm env --use-on-cd --shell zsh)"` in initContent). `programs.fnm` HM module does not exist in this nixpkgs. Existing `~/.nvm` directory can be deleted after Task 6 lands.
- **Zsh plugins**: HM-native `programs.zsh.plugins` sourced from `pkgs.zsh-*`. Drop antidote and `zsh_plugins.txt` entirely.
- **tmux**: dropping entirely, not migrating.
- **Profiles**: no work profile. Single personal config; if a work machine ever appears, it gets its own `darwinConfigurations.<host>` from scratch — don't pre-build branching now.

## Open questions

- **Ghostty cask vs nixpkgs**: `pkgs.ghostty` is Linux-only currently. On darwin, keep the cask.
- **Secrets on darwin**: covered separately by [`1password-darwin-secrets.md`](./1password-darwin-secrets.md). Don't duplicate work here.
