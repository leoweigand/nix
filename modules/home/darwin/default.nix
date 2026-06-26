{ pkgs, ... }:

{
  imports = [
    ./gh.nix
    ./ghostty.nix
    ./herdr.nix
    ./nvim.nix
    ./slimg.nix
    ./zed.nix
    ./zsh.nix
  ];

  home.packages = with pkgs; [
    _1password-cli
    cloudflared
    esptool
    ffmpeg
    skhd
    uv
    yabai
    yt-dlp
  ];

  home.file.".hushlogin".text = "";
}
