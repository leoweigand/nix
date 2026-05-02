{ ... }:

{
  programs.neovim = {
    enable = true;
    withRuby = false;
    withPython3 = false;

    # Real wrapper binaries in the user profile, not shell aliases — they work
    # in scripts, systemd units, and any shell, not just interactive zsh.
    viAlias = true;
    vimAlias = true;

    # Sets EDITOR/VISUAL=nvim via home.sessionVariables (written to ~/.zshenv).
    defaultEditor = true;
  };
}
