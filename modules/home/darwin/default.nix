{ pkgs, ... }:

{
  imports = [
    ./gh.nix
    ./ghostty.nix
    ./herdr.nix
    ./nvim.nix
    ./opencode.nix
    ./slimg.nix
    ./zsh.nix
  ];

  home.packages = with pkgs; [
    ffmpeg
    uv
  ];

  home.file.".hushlogin".text = "";
}
