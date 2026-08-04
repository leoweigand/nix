{ inputs, pkgs, ... }:

{
  nixpkgs.hostPlatform = "aarch64-darwin";

  # Home Manager runs as a nix-darwin module, sharing the system package set.
  home-manager.useGlobalPkgs = true;
  home-manager.useUserPackages = true;
  home-manager.backupFileExtension = "backup";
  home-manager.extraSpecialArgs = {
    inherit inputs;
    hostPlatform = "darwin";
  };

  users.users.leo.home = "/Users/leo";

  home-manager.users.leo = {
    imports = [ ../home ];
    home.stateVersion = "24.11";
  };

  system.primaryUser = "leo";

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
}
