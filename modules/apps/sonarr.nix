{ config, lib, ... }:

let
  cfg = config.homelab.apps.sonarr;
in
{
  options.homelab.apps.sonarr = {
    enable = lib.mkEnableOption "Sonarr TV library automation";
    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "sonarr";
      description = "Sonarr subdomain";
    };
    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "${config.homelab.mounts.fast}/appdata/sonarr";
      description = "Sonarr configuration and database directory";
    };
    libraryDir = lib.mkOption {
      type = lib.types.path;
      default = "${config.homelab.mounts.media}/library/tv";
      description = "TV library writable by Sonarr";
    };
    downloadDir = lib.mkOption {
      type = lib.types.path;
      default = "${config.homelab.mounts.media}/sources/seedbox/deluge/sonarr";
      description = "Synced seedbox downloads writable by Sonarr";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.media = { };

    services.sonarr = {
      enable = true;
      dataDir = cfg.dataDir;
      group = "media";
      settings.server = {
        bindAddress = "127.0.0.1";
        port = 8989;
      };
      settings.auth = {
        method = "External";
        required = "Enabled";
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 sonarr media - -"
      "Z ${cfg.dataDir} - sonarr media - -"
    ];

    systemd.services.sonarr = {
      unitConfig.RequiresMountsFor = lib.mkAfter [
        cfg.libraryDir
        cfg.downloadDir
      ];
      serviceConfig = {
        InaccessiblePaths = [ config.homelab.mounts.media ];
        BindPaths = [
          "${cfg.libraryDir}:/media/library/tv"
          "${cfg.downloadDir}:/media/sources/seedbox/deluge/sonarr"
        ];
      };
    };

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:8989";
      auth = true;
      redirects."/login" = "/";
    };
  };
}
