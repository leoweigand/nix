{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.infra.cloudflareTunnel;
in

{
  imports = [ ./cloudflare-publication ];

  options.homelab.infra.cloudflareTunnel = {
    enable = lib.mkEnableOption "Cloudflare Tunnel outbound connector";

    tokenReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference for the cloudflared tunnel token";
    };
  };

  config = lib.mkIf cfg.enable {
    services.onepassword-secrets.secrets.cfTunnelToken = {
      reference = cfg.tokenReference;
      owner = "cloudflared";
      group = "cloudflared";
      mode = "0400";
    };

    users.users.cloudflared = {
      isSystemUser = true;
      group = "cloudflared";
    };
    users.groups.cloudflared = { };

    systemd.services.cloudflared = {
      description = "Cloudflare Tunnel";
      after = [ "network-online.target" "opnix-secrets.service" ];
      wants = [ "network-online.target" ];
      requires = [ "opnix-secrets.service" ];
      wantedBy = [ "multi-user.target" ];
      path = [ pkgs.cloudflared ];
      # The publication controller manages opted-in hosts; other remote ingress rules stay in the dashboard.
      # The daemon connects out to Cloudflare; no inbound ports are opened.
      script = ''
        exec cloudflared tunnel --no-autoupdate run \
          --token "$(cat ${config.services.onepassword-secrets.secretPaths.cfTunnelToken})"
      '';
      serviceConfig = {
        User = "cloudflared";
        Group = "cloudflared";
        Restart = "on-failure";
        RestartSec = "5s";
      };
    };
  };
}
