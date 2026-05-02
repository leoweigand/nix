{ pkgs, ... }:

{
  programs.bat.enable = true;

  home.packages = with pkgs; [
    ripgrep
    glow
    httpie
  ];
}
