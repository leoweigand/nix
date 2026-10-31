{ pkgs, ... }:

{
  imports = [ ../../modules/darwin/common.nix ];

  home-manager.users.leo.imports = [ ../../modules/home/darwin/personal.nix ];

  homebrew = {
    enable = true;
    enableZshIntegration = true;
    onActivation = {
      autoUpdate = true;
      upgrade = true;
      # Keep manually managed casks (Codex CLI, Ghostty and the font) installed.
      cleanup = "none";
    };
    brews = [
      # keeping in brew, not migrating to nix
      "cocoapods"
    ];
    casks = [
      "artcraft-launcher"
      "beekeeper-studio"
      "blender"
      "lightcraft"
      "orbstack"
      "signal"
    ];
    # Its existing manual app is older; replace only that bundle on first install.
    extraConfig = ''
      cask "calibre", args: { force: true }
    '';
    masApps = {
      "1Password for Safari" = 1569813296;
      "AdGuard Mini" = 1440147259;
      "Bitwarden" = 1352778147;
    };
  };

  environment.systemPackages = [ pkgs.nodejs_26 ];

  system.stateVersion = 5;
}
