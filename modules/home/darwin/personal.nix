{ pkgs, ... }:

{
  home.packages = with pkgs; [
    cloudflared
    esptool
    skhd
    yabai
    yt-dlp
  ];
}
