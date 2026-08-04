{ pkgs, ... }:

{
  home.packages = with pkgs; [
    _1password-cli
    cloudflared
    esptool
    skhd
    yabai
    yt-dlp
  ];
}
