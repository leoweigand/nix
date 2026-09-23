{ pkgs, ... }:

{
  home.packages = with pkgs; [
    cloudflared
    esptool
    nixos-rebuild
    skhd
    yabai
    yt-dlp
  ];
}
