{ inputs, machineName, pkgs, ... }:

let
  cleanshot = pkgs.stdenvNoCC.mkDerivation {
    pname = "cleanshot";
    version = "4.8.11";

    src = pkgs.fetchurl {
      url = "https://updates.getcleanshot.com/v3/CleanShot-X-4.8.11.dmg";
      hash = "sha256-KYr7PQhe5jQ9rpVLoqdCm9YT5q2elCyPeQCGiM6xGoE=";
    };

    dontUnpack = true;
    dontStrip = true;

    installPhase = ''
      runHook preInstall
      mountPoint="$TMPDIR/cleanshot"
      mkdir -p "$mountPoint"
      /usr/bin/hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mountPoint" "$src"
      trap '/usr/bin/hdiutil detach -quiet "$mountPoint"' EXIT
      mkdir -p "$out/Applications"
      cp -R "$mountPoint/CleanShot X.app" "$out/Applications/"
      runHook postInstall
    '';

    meta = {
      license = pkgs.lib.licenses.unfree;
      platforms = [ "aarch64-darwin" ];
    };
  };
in
{
  imports = [ ../machine-identity.nix ];

  nixpkgs.hostPlatform = "aarch64-darwin";
  nixpkgs.config.allowUnfreePredicate =
    pkg:
    builtins.elem (pkgs.lib.getName pkg) [
      "1password-cli"
      "claude-code"
      "cleanshot"
    ];

  # Home Manager runs as a nix-darwin module, sharing the system package set.
  home-manager.useGlobalPkgs = true;
  home-manager.useUserPackages = true;
  home-manager.backupFileExtension = "backup";
  home-manager.extraSpecialArgs = {
    inherit inputs machineName;
    hostPlatform = "darwin";
  };

  users.users.leo.home = "/Users/leo";

  homebrew.casks = [
    "keepingyouawake"
  ];

  system.activationScripts.homebrew.text = pkgs.lib.mkBefore ''
    if [ -x /opt/homebrew/bin/brew ] && sudo --user=leo --set-home /opt/homebrew/bin/brew list --cask cleanshot >/dev/null 2>&1; then
      sudo --user=leo --set-home /opt/homebrew/bin/brew uninstall --cask cleanshot
    fi
    if [ -e '/Applications/Nix Apps/CleanShot X.app' ] && [ ! -e '/Applications/CleanShot X.app' ]; then
      ln -s 'Nix Apps/CleanShot X.app' '/Applications/CleanShot X.app'
    fi
  '';

  environment.systemPackages = [ cleanshot ];

  home-manager.users.leo = {
    imports = [
      ../home/common
      ../home/darwin
    ];
    home.packages = [ pkgs._1password-cli ];
    home.stateVersion = "24.11";
  };

  system.primaryUser = "leo";

  system.keyboard = {
    enableKeyMapping = true;
    remapCapsLockToEscape = true;
  };

  time.timeZone = "Europe/Berlin";

  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    # Keep an accidental source build responsive instead of letting several
    # highly parallel compiler jobs contend for all CPU and memory.
    max-jobs = 2;
    cores = 4;
  };

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
    finder = {
      ShowPathbar = true;
      ShowStatusBar = true;
    };
    # false = "Only in Stage Manager", so clicking the wallpaper no longer
    # sweeps every window aside.
    WindowManager.EnableStandardClickToShowDesktop = false;
  };

  fonts.packages = [ pkgs.nerd-fonts.jetbrains-mono ];
}
