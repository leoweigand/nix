{ config, lib, ... }:

let
  cfg = config.homelab.apps.seerr;
in
{
  options.homelab.apps.seerr = {
    enable = lib.mkEnableOption "Seerr media discovery and requests";
    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "discover";
      description = "Public-facing Seerr subdomain";
    };
    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "${config.homelab.mounts.fast}/appdata/seerr";
      description = "Seerr configuration and database directory";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.seerr = { };
    users.users.seerr = {
      isSystemUser = true;
      group = "seerr";
      home = cfg.dataDir;
    };

    services.seerr = {
      enable = true;
      configDir = cfg.dataDir;
      port = 5055;
      stateRevision = 1;
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 seerr seerr - -"
      "Z ${cfg.dataDir} - seerr seerr - -"
    ];

    systemd.services.seerr.serviceConfig = {
      DynamicUser = lib.mkForce false;
      User = "seerr";
      Group = "seerr";
      StateDirectory = lib.mkForce "";
      ReadWritePaths = [ cfg.dataDir ];
      InaccessiblePaths = [ config.homelab.mounts.media ];
    };
    systemd.services.seerr.environment.HOST = "127.0.0.1";

    homelab.infra.edge.proxies.${cfg.subdomain}.upstream = "http://127.0.0.1:5055";
  };
}
