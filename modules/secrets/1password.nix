{ config, lib, pkgs, ... }:

{
  # Enable opnix for 1Password secret management
  services.onepassword-secrets = {
    enable = true;
    # Token file contains the 1Password service account token
    # Initialize with: sudo opnix token set
    tokenFile = "/etc/opnix-token";
  };

  # Ensure opnix-secrets waits for network to be fully ready
  # This prevents DNS lookup failures on first boot
  systemd.services.opnix-secrets = {
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
  };

  # Ensure Tailscale's autoconnect waits for secrets to be available
  # (The native tailscaled-autoconnect.service is created by services.tailscale.authKeyFile)
  systemd.services.tailscaled-autoconnect = lib.mkIf config.services.tailscale.enable {
    after = [ "opnix-secrets.service" ];
    requires = [ "opnix-secrets.service" ];
  };

  # The 1Password service account token should be set using:
  #   sudo opnix token set
  #
  # This will securely store the token in /etc/opnix-token
  # The token is NOT stored in the Nix configuration.
}
