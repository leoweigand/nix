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

  time.timeZone = "Europe/Berlin";

  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  system.stateVersion = 5;
}
