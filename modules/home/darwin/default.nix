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
    # psql and pg_dump; nixpkgs has no client-only build, so this is the full
    # server package. No server is enabled.
    postgresql
    uv
  ];

  # pnpm's macOS default global root, and the bin dir it links `pnpm add -g`
  # packages into. It refuses to install globally unless the bin dir is on PATH.
  home.sessionVariables.PNPM_HOME = "$HOME/Library/pnpm";
  home.sessionPath = [ "$HOME/Library/pnpm/bin" ];

  home.file.".hushlogin".text = "";
}
