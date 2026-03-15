{ config, lib, pkgs, ... }:

{
  services.onepassword-secrets = {
    enable = true;
    tokenFile = "/etc/opnix-token";
  };

  # Wait for network to prevent DNS failures on first boot
  systemd.services.opnix-secrets = {
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
  };

  systemd.services.tailscaled-autoconnect = lib.mkIf config.services.tailscale.enable {
    after = [ "opnix-secrets.service" ];
    requires = [ "opnix-secrets.service" ];
  };
}
