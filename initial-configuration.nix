{ config, pkgs, lib, ... }:

{
  # Import hardware configuration (will be generated on Pi)
  imports = [ ./hardware-configuration.nix ];

  # Use the extlinux boot loader (required for Raspberry Pi)
  boot.loader.grub.enable = false;
  boot.loader.generic-extlinux-compatible.enable = true;

  # Networking
  # This Pi will be the reverse proxy gateway for the homelab
  networking = {
    hostName = "guinan";
    # NetworkManager provides easier WiFi/network management via nmcli
    networkmanager.enable = true;

    # Using DHCP with router reservation (configured on router side)
    # The router will always assign the same IP based on MAC address
  };

  # Time zone configuration
  time.timeZone = "Europe/Berlin";

  # Enable SSH - CRITICAL for headless operation
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;  # Disable password auth for security
      PermitRootLogin = "no";          # Disable root login
    };
  };

  # User account configuration
  users.users.leo = {
    isNormalUser = true;
    extraGroups = [ "wheel" "networkmanager" ];  # wheel group provides sudo access
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDevMcuw1B5G4A3K2RbCgA9rz43bG4Imz2nKm9K3X8lL leo@weigand.io"
    ];
    # Optional: Set hashed password as backup authentication method
    # Generate with: mkpasswd -m sha-512
    # hashedPassword = "...";
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
  ];

  # Enable mDNS for easier discovery (guinan.local)
  # Useful during initial setup before DNS is configured
  services.avahi = {
    enable = true;
    nssmdns4 = true;
    publish = {
      enable = true;
      addresses = true;
      domain = true;
      hinfo = true;
      userServices = true;
      workstation = true;
    };
  };

  # Firewall configuration
  networking.firewall = {
    enable = true;
    allowedTCPPorts = [ 22 ];  # SSH access
    # Future ports to add:
    # - 443 for Caddy HTTPS
    # - 8080 for Cloudflare Tunnel (localhost only)
  };

  # This value determines the NixOS release from which the default
  # settings for stateful data, like file locations and database versions
  # on your system were taken. It's perfectly fine and recommended to leave
  # this value at the release version of your first install.
  system.stateVersion = "24.11"; # Did you read the comment?
}
