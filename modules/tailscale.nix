{ config, lib, pkgs, ... }:

{
  # Define the Tailscale auth key secret
  # OpNix will fetch this from 1Password at activation time
  services.onepassword-secrets.secrets.tailscaleAuthkey = {
    reference = "op://Homelab/Tailscale/authKey";
    owner = "root";
    group = "root";
    mode = "0400";  # Read-only for root
  };

  # Enable Tailscale VPN with automatic authentication
  services.tailscale = {
    enable = true;
    useRoutingFeatures = "both";

    # Use native authKeyFile option - this automatically creates
    # a tailscaled-autoconnect.service that handles authentication
    authKeyFile = config.services.onepassword-secrets.secretPaths.tailscaleAuthkey;

    # Extra flags for tailscale up (only work when authKeyFile is set)
    extraUpFlags = [
      "--ssh"                           # Enable Tailscale SSH
      "--hostname=${config.networking.hostName}"  # Use NixOS hostname
    ];
  };

  # Open firewall for Tailscale
  networking.firewall = {
    # Allow Tailscale UDP port
    allowedUDPPorts = [ config.services.tailscale.port ];
    # Allow traffic from Tailscale interface
    trustedInterfaces = [ "tailscale0" ];
  };
}
