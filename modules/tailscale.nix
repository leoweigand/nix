{ config, lib, pkgs, ... }:

{
  services.onepassword-secrets.secrets.tailscaleAuthkey = {
    reference = "op://Homelab/Tailscale/authKey";
    owner = "root";
    group = "root";
    mode = "0400";
  };

  services.tailscale = {
    enable = true;
    useRoutingFeatures = "both";
    authKeyFile = config.services.onepassword-secrets.secretPaths.tailscaleAuthkey;
    extraUpFlags = [
      "--ssh"
      "--hostname=${config.networking.hostName}"
    ];
  };

  networking.firewall = {
    allowedUDPPorts = [ config.services.tailscale.port ];
    trustedInterfaces = [ "tailscale0" ];
  };
}
