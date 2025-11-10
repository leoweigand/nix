{ config, lib, pkgs, ... }:

{
  # Enable Tailscale VPN
  services.tailscale = {
    enable = true;
    # Allow Tailscale to modify routing table
    useRoutingFeatures = "both";
  };

  # Tailscale auth key will be fetched from 1Password at activation time
  # The auth key is stored in 1Password as:
  # - Vault: Homelab
  # - Item: Tailscale
  # - Field: authKey
  #
  # The secret is declaratively defined and automatically fetched by opnix

  # Define the Tailscale auth key secret
  services.onepassword-secrets.secrets.tailscaleAuthkey = {
    reference = "op://Homelab/Tailscale/authKey";
    owner = "root";
    services = [ "tailscale-autoconnect" ];
  };

  systemd.services.tailscale-autoconnect = {
    description = "Automatic connection to Tailscale";
    after = [ "network-pre.target" "tailscale.service" ];
    wants = [ "network-pre.target" "tailscale.service" ];
    wantedBy = [ "multi-user.target" ];

    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };

    script = ''
      # Wait for tailscale to be ready
      ${pkgs.coreutils}/bin/sleep 2

      # Check if already connected
      status="$(${pkgs.tailscale}/bin/tailscale status --json | ${pkgs.jq}/bin/jq -r .BackendState)"
      if [ "$status" = "Running" ]; then
        echo "Already connected to Tailscale"
        exit 0
      fi

      # Read auth key from secret file (provided by opnix)
      authkey=$(cat ${config.services.onepassword-secrets.secretPaths.tailscaleAuthkey})

      if [ -z "$authkey" ]; then
        echo "ERROR: Failed to read Tailscale auth key"
        exit 1
      fi

      # Authenticate with Tailscale
      echo "Authenticating with Tailscale..."
      ${pkgs.tailscale}/bin/tailscale up \
        --authkey="$authkey" \
        --hostname="${config.networking.hostName}" \
        --ssh

      echo "Tailscale connection established"
    '';
  };

  # Open firewall for Tailscale
  networking.firewall = {
    # Allow Tailscale UDP port
    allowedUDPPorts = [ config.services.tailscale.port ];
    # Allow traffic from Tailscale interface
    trustedInterfaces = [ "tailscale0" ];
  };

  # Enable Tailscale SSH (integrated with ACLs and MFA)
  # This provides secure SSH access via Tailscale without opening port 22 publicly
}
