{ config, pkgs, lib, ... }:

{
  # Time zone configuration
  time.timeZone = "Europe/Berlin";

  # Enable SSH - CRITICAL for remote operation
  # SSH access is provided via Tailscale only (no public SSH)
  services.openssh = {
    enable = true;
    openFirewall = false;  # Don't open port 22 - use Tailscale SSH instead
    settings = {
      PasswordAuthentication = false;  # Disable password auth for security
      PermitRootLogin = "no";          # Disable root login
    };
  };

  # User account configuration
  users.users.leo = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];  # wheel group provides sudo access
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDevMcuw1B5G4A3K2RbCgA9rz43bG4Imz2nKm9K3X8lL "
    ];
  };

  # Passwordless sudo for wheel group (convenient for remote management)
  security.sudo.wheelNeedsPassword = false;

  # Essential packages
  environment.systemPackages = with pkgs; [
    vim
    git
    htop
    wget
    curl
    tmux
    jq  # Used by Tailscale autoconnect script
  ];

  # Automatic garbage collection to save disk space
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 30d";
  };

  # Enable flakes and nix-command (modern Nix features)
  nix.settings.experimental-features = [ "nix-command" "flakes" ];
}
