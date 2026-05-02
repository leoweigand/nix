{ pkgs, ... }:

{
  imports = [
    ./gh.nix
    ./ghostty.nix
    ./nvim.nix
    ./zed.nix
    ./zsh.nix
  ];

  home.packages = with pkgs; [
    _1password-cli
    cloudflared
    ffmpeg
    skhd
    yabai
    yt-dlp
  ];

  home.file.".hushlogin".text = "";
}
