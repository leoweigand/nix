{ config, pkgs, lib, ... }:

{
  nixpkgs.hostPlatform = "aarch64-darwin";

  # Home Manager runs as a nix-darwin module rather than standalone
  home-manager.useGlobalPkgs = true;    # reuse the system nixpkgs instance (avoids a second eval)
  home-manager.useUserPackages = true;  # install HM packages into the user profile under /etc/profiles
  home-manager.extraSpecialArgs = { hostPlatform = "darwin"; };  # consumed by modules/home/default.nix dispatch

  # nix-darwin: users.users.<name>.home defaults to null, home-manager picks this up
  users.users.leo.home = "/Users/leo";

  home-manager.users.leo = {
    imports = [ ../../modules/home ];
    home.stateVersion = "24.11";
  };

  system.primaryUser = "leo";

  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "zap";
    };
    brews = [
      # keeping in brew, not migrating to nix
      "cocoapods"
      "deno"
    ];
    casks = [
      "1password-cli"
      "blender"
      "codex"
      "font-ia-writer-quattro"
      "ghostty"
      "macwhisper"
      "obsidian"
      "raycast"
      "tailscale-app"
      "zed"
    ];
  };

  time.timeZone = "Europe/Berlin";

  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  system.defaults = {
    NSGlobalDomain = {
      AppleKeyboardUIMode = 3;  # full keyboard access (tab in dialogs)
      InitialKeyRepeat = 12;
      KeyRepeat = 2;
      "com.apple.trackpad.scaling" = 7.0;
    };
    dock = {
      autohide-delay = 0.0;
      minimize-to-application = true;
      show-recents = false;
    };
  };

  fonts.packages = [ pkgs.nerd-fonts.jetbrains-mono ];

  system.stateVersion = 5;
}
