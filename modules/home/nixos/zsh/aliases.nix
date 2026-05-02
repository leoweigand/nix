{ ... }:

{
  # `lg` has to be a function (not a shellAlias) because it cd's into the
  # directory lazygit's "open in shell" action picks. Lazygit can't change
  # the parent shell's cwd directly; it writes the chosen path to
  # LAZYGIT_NEW_DIR_FILE on exit and the wrapper consumes it.
  programs.zsh.initContent = ''
    lg() {
      export LAZYGIT_NEW_DIR_FILE=~/.lazygit/newdir
      lazygit "$@"
      if [[ -f "$LAZYGIT_NEW_DIR_FILE" ]]; then
        cd "$(cat "$LAZYGIT_NEW_DIR_FILE")"
        rm -f "$LAZYGIT_NEW_DIR_FILE"
      fi
    }
  '';
}
