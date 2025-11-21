{ config, pkgs, lib, ... }:

{
  time.timeZone = "Europe/Berlin";

  # SSH access via Tailscale only (no public SSH)
  services.openssh = {
    enable = true;
    openFirewall = false;
    settings = {
      PasswordAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  users.users.leo = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];  # wheel group provides sudo access
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDevMcuw1B5G4A3K2RbCgA9rz43bG4Imz2nKm9K3X8lL "
    ];
  };

  security.sudo.wheelNeedsPassword = false;

  environment.systemPackages = with pkgs; [
    vim
    git
    htop
    wget
    curl
    tmux
    jq
  ];

  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };

  nix.settings.experimental-features = [ "nix-command" "flakes" ];
}
