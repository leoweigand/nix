{ config, lib, ... }:

let
  cfg = config.homelab.apps.radarr;
in
{
  options.homelab.apps.radarr = {
    enable = lib.mkEnableOption "Radarr movie library automation";
    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "radarr";
      description = "Radarr subdomain";
    };
    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "${config.homelab.mounts.fast}/appdata/radarr";
      description = "Radarr configuration and database directory";
    };
    libraryDir = lib.mkOption {
      type = lib.types.path;
      default = "${config.homelab.mounts.media}/library/films";
      description = "Film library writable by Radarr";
    };
    downloadDir = lib.mkOption {
      type = lib.types.path;
      default = "${config.homelab.mounts.media}/sources/seedbox/deluge/radarr";
      description = "Synced seedbox downloads writable by Radarr";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.media = { };

    services.radarr = {
      enable = true;
      dataDir = cfg.dataDir;
      group = "media";
      settings.server = {
        bindAddress = "127.0.0.1";
        port = 7878;
      };
      settings.auth = {
        method = "External";
        required = "Enabled";
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 radarr media - -"
      "Z ${cfg.dataDir} - radarr media - -"
    ];

    systemd.services.radarr = {
      unitConfig.RequiresMountsFor = lib.mkAfter [
        cfg.libraryDir
        cfg.downloadDir
      ];
      serviceConfig = {
        InaccessiblePaths = [ config.homelab.mounts.media ];
        BindPaths = [
          "${cfg.libraryDir}:/media/library/films"
          "${cfg.downloadDir}:/media/sources/seedbox/deluge/radarr"
        ];
      };
    };

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:7878";
      auth = true;
      redirects."/login" = "/";
    };
  };
}
