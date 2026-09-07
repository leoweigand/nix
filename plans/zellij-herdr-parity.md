# Aligning zellij with herdr

Goal: make zellij a drop-in fallback for herdr. Same prefix, same verbs, same muscle memory, so switching multiplexer costs nothing. Both configs move into this repo.

Applies to `ro` and `crusher` — `modules/home/common` is only imported by `modules/darwin/common.nix`, so zellij is already darwin-only in practice, same as herdr.

---

## Why this is mostly a config change

Zellij already ships a mode built for this. Its `tmux` mode is entered with **Ctrl+b** and is one-shot: press the prefix, press a key, the action fires, the mode exits. That is herdr's prefix-mode model exactly. No custom mode is needed, only a re-bound one.

Two things block it today:

1. The default config ends with `shared_except "tmux" "locked" { bind "Ctrl b" { SwitchToMode "Tmux"; } }`. Our `default_mode` is `locked`, so **Ctrl+b does not exist in our setup at all**. The prefix has to be re-added inside the `locked` block.
2. Every binding in zellij's `tmux` mode ends with `SwitchToMode "Normal"`. Normal is not passthrough — the next keystroke gets eaten by zellij instead of reaching the pane. Every action must end with `SwitchToMode "Locked"` instead.

Zellij's own `tmux` bindings are also cleared, because several of them (`Space` → NextSwapLayout, `o` → FocusNextPane) never leave the mode and silently swallow the following keystroke.

## Decisions

- **Both configs are managed in Nix, written by hand.** No shared keymap generator. Each file spells out its own bindings; the parity-relevant herdr keys are pinned explicitly rather than left to herdr's defaults, so a herdr release cannot quietly break the mapping.
- **Zellij sessions stand in for herdr workspaces.** `prefix+w` opens zellij's session-manager plugin, matching herdr's workspace picker. Tab keys stay on zellij tabs. Workspace create, rename, and close have no zellij action and stay unbound.
- **The three herdr plugin bindings stay where they are.** `prefix+e` opens the nvim sidebar in herdr and edits scrollback in zellij; `prefix+o` and `prefix+shift+L` are herdr-only. Everything else lines up.
- **Herdr's config is an out-of-store symlink**, like `modules/home/darwin/nvim`. Herdr's Settings screen writes to `config.toml` with a plain `fs::write`, so the symlink survives and its changes show up as a git diff. A read-only store copy would break the theme, sound, toast, and indicator toggles.

## Key map

Herdr's semantics were read from its source, not inferred: `split_vertical` (`prefix+v`) calls `SplitDirection::Right` and `split_horizontal` (`prefix+minus`) calls `Down` — vim's convention, not tmux's.

| Action | Key | herdr | zellij |
|---|---|---|---|
| Send prefix through | `Ctrl b` | pass-through to pane | `Write 2` |
| Leave prefix | `Esc` | leave prefix mode | `SwitchToMode "Locked"` |
| Detach | `q` | `detach` | `Detach` |
| Workspace / session picker | `w` | `workspace_picker` | `LaunchOrFocusPlugin "session-manager"` |
| Settings | `s` | `settings` | `LaunchOrFocusPlugin "configuration"` |
| New tab | `c` | `new_tab` | `NewTab` |
| Prev / next tab | `p` / `n` | `previous_tab` / `next_tab` | `GoToPreviousTab` / `GoToNextTab` |
| Switch tab | `1`–`9` | `switch_tab` | `GoToTab N` |
| Rename tab | `T` | `rename_tab` | `RenameTab` mode |
| Close tab | `X` | `close_tab` | `CloseTab` |
| Split right | `v` | `split_vertical` | `NewPane "Right"` |
| Split down | `-` | `split_horizontal` | `NewPane "Down"` |
| Close pane | `x` | `close_pane` | `CloseFocus` |
| Zoom pane | `z` | `zoom` | `ToggleFocusFullscreen` |
| Rename pane | `P` | `rename_pane` | `RenamePane` mode |
| Focus pane | `h j k l` | `focus_pane_*` | `MoveFocus` |
| Swap pane | `H J K` | `swap_pane_*` | `MovePane` |
| Cycle pane | `Tab` / `Shift Tab` | `cycle_pane_*` | `FocusNextPane` / `FocusPreviousPane` |
| Resize mode | `r` | `resize_mode` | `SwitchToMode "Resize"` |
| Copy / scroll mode | `[` | `copy_mode` | `SwitchToMode "Scroll"` |
| Edit scrollback | `e` | `edit_scrollback` (shadowed locally) | `EditScrollback` |

Resize mode needs no extra work: both use `h j k l` to grow toward an edge and `Esc`/`Enter` to leave.

## What has no zellij equivalent

Left unbound. These are the reasons to stay on herdr, and they are worth knowing before falling back.

- The agent sidebar (`prefix+b`), agent lifecycle states, notifications, and the `goto` navigator.
- Worktree helpers (`prefix+shift+G`) and the `herdr worktree` workflow.
- Workspace create, rename, and close. Zellij's session-manager can create a session, but there is no bindable action.
- `reload_config` — zellij has no reload action.
- The herdr-nvim and herdr-spreader plugins.
- **Copy mode is only a partial match.** Herdr's is a full vi-visual mode: `w e b`, `v`, `y`, `/`, `n N`, `$`. Zellij's Scroll mode scrolls and searches only; copying is by mouse selection with `copy_on_select`.

---

## Changes

### `modules/home/common/zellij.nix`

Keep the existing `settings` block and add the keybinds through `programs.zellij.extraConfig`. Home Manager renders `settings` with `toKDL` and appends `extraConfig` verbatim — `toKDL` cannot express zellij keybinds at all, because a Nix attrset has no room for repeated `bind` nodes that carry both arguments and children.

```nix
{ ... }:

{
  programs.zellij = {
    enable = true;

    settings = {
      simplified_ui = true;
      show_startup_tips = false;
      # Require unlocking before sending key bindings to zellij; avoids key conflicts with apps inside
      default_mode = "locked";
    };

    # Keybinds cannot go through `settings` — toKDL has no way to emit repeated
    # `bind` nodes that carry both arguments and a child block.
    extraConfig = ''
      keybinds {
          locked {
              // Ctrl+b is unbound in locked mode by default (shared_except "tmux" "locked"),
              // and locked is our default mode, so re-add the prefix here.
              bind "Ctrl b" { SwitchToMode "Tmux"; }
          }

          // Herdr's prefix mode: one key, one action, straight back to passthrough.
          // clear-defaults drops zellij's own tmux bindings — some of them (Space, o)
          // never leave the mode and swallow the next keystroke.
          tmux clear-defaults=true {
              bind "Ctrl b" { Write 2; SwitchToMode "Locked"; }  // 2 = ^B, sends the prefix to the pane
              bind "Esc" { SwitchToMode "Locked"; }
              bind "q" { Detach; }
              bind "w" {
                  LaunchOrFocusPlugin "session-manager" {
                      floating true
                      move_to_focused_tab true
                  }
                  SwitchToMode "Locked"
              }
              bind "s" {
                  LaunchOrFocusPlugin "configuration" {
                      floating true
                      move_to_focused_tab true
                  }
                  SwitchToMode "Locked"
              }

              bind "c" { NewTab; SwitchToMode "Locked"; }
              bind "n" { GoToNextTab; SwitchToMode "Locked"; }
              bind "p" { GoToPreviousTab; SwitchToMode "Locked"; }
              bind "T" { SwitchToMode "RenameTab"; TabNameInput 0; }
              bind "X" { CloseTab; SwitchToMode "Locked"; }
              bind "1" { GoToTab 1; SwitchToMode "Locked"; }
              bind "2" { GoToTab 2; SwitchToMode "Locked"; }
              bind "3" { GoToTab 3; SwitchToMode "Locked"; }
              bind "4" { GoToTab 4; SwitchToMode "Locked"; }
              bind "5" { GoToTab 5; SwitchToMode "Locked"; }
              bind "6" { GoToTab 6; SwitchToMode "Locked"; }
              bind "7" { GoToTab 7; SwitchToMode "Locked"; }
              bind "8" { GoToTab 8; SwitchToMode "Locked"; }
              bind "9" { GoToTab 9; SwitchToMode "Locked"; }

              bind "v" { NewPane "Right"; SwitchToMode "Locked"; }
              bind "-" { NewPane "Down"; SwitchToMode "Locked"; }
              bind "x" { CloseFocus; SwitchToMode "Locked"; }
              bind "z" { ToggleFocusFullscreen; SwitchToMode "Locked"; }
              bind "P" { SwitchToMode "RenamePane"; PaneNameInput 0; }
              bind "h" { MoveFocus "Left"; SwitchToMode "Locked"; }
              bind "j" { MoveFocus "Down"; SwitchToMode "Locked"; }
              bind "k" { MoveFocus "Up"; SwitchToMode "Locked"; }
              bind "l" { MoveFocus "Right"; SwitchToMode "Locked"; }
              bind "H" { MovePane "Left"; SwitchToMode "Locked"; }
              bind "J" { MovePane "Down"; SwitchToMode "Locked"; }
              bind "K" { MovePane "Up"; SwitchToMode "Locked"; }
              bind "L" { MovePane "Right"; SwitchToMode "Locked"; }
              bind "Tab" { FocusNextPane; SwitchToMode "Locked"; }
              bind "Shift Tab" { FocusPreviousPane; SwitchToMode "Locked"; }

              // Sticky sub-modes, same as herdr
              bind "r" { SwitchToMode "Resize"; }
              bind "[" { SwitchToMode "Scroll"; }
              bind "e" { EditScrollback; SwitchToMode "Locked"; }
          }

          // Sub-modes must exit to locked, not normal, or the next keystroke is eaten.
          shared_except "normal" "locked" {
              bind "Enter" "Esc" { SwitchToMode "Locked"; }
          }
          resize {
              bind "Ctrl n" { SwitchToMode "Locked"; }
          }
          scroll {
              bind "Ctrl s" { SwitchToMode "Locked"; }
              bind "Ctrl c" { ScrollToBottom; SwitchToMode "Locked"; }
              bind "e" { EditScrollback; SwitchToMode "Locked"; }
          }
          renametab {
              bind "Esc" { UndoRenameTab; SwitchToMode "Locked"; }
          }
          renamepane {
              bind "Esc" { UndoRenamePane; SwitchToMode "Locked"; }
          }
      }
    '';
  };
}
```

Zellij's other native mode entries (`Ctrl p`, `Ctrl t`, `Ctrl o`, `Ctrl h`) are left alone. They are unreachable from locked mode and harmless from a sub-mode.

### `modules/home/darwin/herdr.nix`

```nix
{ config, inputs, pkgs, ... }:

{
  home.packages = [
    inputs.herdr.packages.${pkgs.stdenv.hostPlatform.system}.herdr
  ];

  # mkOutOfStoreSymlink keeps the file writable so herdr's Settings screen can
  # still save theme, sound, and toast changes — it writes config.toml in place
  xdg.configFile."herdr/config.toml".source =
    config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/git/nix/modules/home/darwin/herdr-config.toml";
}
```

### `modules/home/darwin/herdr-config.toml`

Existing content, plus the parity keys pinned. The `[[keys.command]]` blocks must stay last — TOML would otherwise fold any following scalar into the array-of-tables entry.

```toml
onboarding = false

[keys]
prefix = "ctrl+b"

# Pinned rather than left to herdr's defaults, so a release cannot silently
# break parity with zellij — see plans/zellij-herdr-parity.md
detach = "prefix+q"
workspace_picker = "prefix+w"
settings = "prefix+s"
new_tab = "prefix+c"
previous_tab = "prefix+p"
next_tab = "prefix+n"
switch_tab = "prefix+1..9"
rename_tab = "prefix+shift+t"
close_tab = "prefix+shift+x"
rename_pane = "prefix+shift+p"
split_vertical = "prefix+v"
split_horizontal = "prefix+minus"
close_pane = "prefix+x"
zoom = "prefix+z"
resize_mode = "prefix+r"
copy_mode = "prefix+["
focus_pane_left = "prefix+h"
focus_pane_down = "prefix+j"
focus_pane_up = "prefix+k"
focus_pane_right = "prefix+l"
swap_pane_left = "prefix+shift+h"
swap_pane_down = "prefix+shift+j"
swap_pane_up = "prefix+shift+k"
# swap_pane_right is deliberately left unpinned — pinning "prefix+shift+l"
# explicitly beats the herdr-spreader command on the same key and disables it.
# An implicit default loses to a custom command; an explicit one wins.
cycle_pane_next = "prefix+tab"
cycle_pane_previous = "prefix+shift+tab"

# Herdr-only, no zellij equivalent
toggle_sidebar = "prefix+b"
goto = "prefix+g"
new_workspace = "prefix+shift+n"
rename_workspace = "prefix+shift+w"
close_workspace = "prefix+shift+d"
new_worktree = "prefix+shift+g"
reload_config = "prefix+shift+r"

# Apply the herdr-spreader layout from ~/.config/herdr/plugins/config/herdr-spreader/config.yaml
[[keys.command]]
key = "prefix+shift+l"
type = "plugin_action"
command = "herdr-spreader.apply"
description = "apply layout"

[[keys.command]]
key = "prefix+e"
type = "plugin_action"
command = "chmarax.herdr-nvim.toggle"
description = "nvim sidebar"

[[keys.command]]
key = "prefix+o"
type = "plugin_action"
command = "chmarax.herdr-nvim.pick-file"
description = "open file from agent output"
```

Before switching, remove the stale `config.toml.bak` and `config.toml.pre-herdr-nvim` from `~/.config/herdr/`, and let `home-manager.backupFileExtension` take the live file out of the way.

---

## Trade-offs to accept

- **Zellij's Settings screen cannot save.** `prefix+s` opens the configuration plugin, but `config.kdl` is a read-only store symlink, so changes will not persist. It stays bound as a way to read the active keybinds.
- **Herdr's Settings screen writes into the repo.** Toggling theme or sound in herdr edits `modules/home/darwin/herdr-config.toml` directly and shows up as an uncommitted change. Same behaviour as `nvim/lazy-lock.json` today.
- **`prefix+e` means two different things.** Nvim sidebar in herdr, edit-scrollback in zellij.
- **`prefix+shift+L` swaps a pane right in zellij and applies the spreader layout in herdr.** Herdr's `swap_pane_right` default sits on that key, so swap-right is unreachable in herdr today — the custom command wins. `herdr config check` reports a conflict the moment the default is written out explicitly. Moving the spreader binding to a free key would give full parity on `H J K L`; leaving it costs one verb.
- **Copy mode is the real downgrade.** Falling back to zellij means losing vi-visual selection.

## Verification

1. `zellij --config <generated config.kdl> setup --check` must report `[CONFIG FILE]: Well defined.` The config above was checked against zellij 0.44.3 and parses, including `bind "Shift Tab"`, `bind "-"`, and per-mode `clear-defaults=true`.
2. `herdr config check` must report `config: ok` on the new `config.toml` — it catches a pinned action shadowing a `[[keys.command]]` binding, which is how the `swap_pane_right` clash above was found. The block above was checked against herdr 0.8.0 with `HERDR_CONFIG_PATH` pointed at it.
3. Ask for the `darwin-rebuild` run (it needs sudo, so it is not run from an agent).
4. In a fresh `zellij attach -c main`: Ctrl+b then each of `c n p 1 v - x z h j k l Tab r [ q`. Confirm every one lands back in locked mode and the following keystroke reaches the pane.
5. Ctrl+b Ctrl+b in a shell must move the cursor back one character, proving the prefix passes through.
