{ pkgs, ... }:

{
  home.packages = with pkgs; [
    cloudflared
    esptool
    nixos-rebuild
    postgresql  # client tools (psql, pg_dump); no server is enabled
    skhd
    yabai
    yt-dlp
  ];
}
