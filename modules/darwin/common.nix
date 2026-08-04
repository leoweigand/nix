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
    imports = [
      ../home/common
      ../home/darwin
    ];
    home.stateVersion = "24.11";
  };

  system.primaryUser = "leo";

  system.keyboard = {
    enableKeyMapping = true;
    remapCapsLockToEscape = true;
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
    trackpad = {
      Clicking = true;
      TrackpadThreeFingerDrag = true;
      TrackpadThreeFingerVertSwipeGesture = 0;
    };
    universalaccess.closeViewScrollWheelToggle = true;
    dock = {
      autohide-delay = 0.0;
      minimize-to-application = true;
      showAppExposeGestureEnabled = false;
      show-recents = false;
    };
  };

  fonts.packages = [ pkgs.nerd-fonts.jetbrains-mono ];
}
