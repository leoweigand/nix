{ pkgs, ... }:

{
  imports = [
    ./gh.nix
    ./ghostty.nix
    ./herdr.nix
    ./llm.nix
    ./nvim.nix
    ./opencode.nix
    ./slimg.nix
    ./zsh.nix
  ];

  home.packages = with pkgs; [
    ffmpeg
    pnpm
    uv
  ];

  # pnpm refuses `pnpm add -g` unless PNPM_HOME is set; this is its macOS default.
  home.sessionVariables.PNPM_HOME = "$HOME/Library/pnpm";
  home.sessionPath = [ "$HOME/Library/pnpm" ];

  home.file.".hushlogin".text = "";
}
