{ pkgs, ... }:

{
  programs.bat.enable = true;

  home.packages = with pkgs; [
    gh
    ripgrep
    ffmpeg
  ];
}
