{ config, pkgs, lib, ... }:

{
  nixpkgs.hostPlatform = "aarch64-darwin";

  # Home Manager runs as a nix-darwin module rather than standalone
  home-manager.useGlobalPkgs = true;    # reuse the system nixpkgs instance (avoids a second eval)
  home-manager.useUserPackages = true;  # install HM packages into the user profile under /etc/profiles

  home-manager.users.leo = {
    # macOS home directory must be set explicitly — nix-darwin doesn't infer it
    home.homeDirectory = "/Users/leo";
    home.stateVersion = "24.11";
  };

  time.timeZone = "Europe/Berlin";

  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  system.stateVersion = 5;
}
