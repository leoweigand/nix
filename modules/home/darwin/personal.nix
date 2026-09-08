{ pkgs, ... }:

{
  home.packages = with pkgs; [
    cloudflared
    esptool
    postgresql  # client tools (psql, pg_dump); no server is enabled
    skhd
    yabai
    yt-dlp
  ];
}
