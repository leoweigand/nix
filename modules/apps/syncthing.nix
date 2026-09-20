{ config, lib, ... }:

let
  cfg = config.homelab.apps.syncthing;
in
{
  options.homelab.apps.syncthing = {
    enable = lib.mkEnableOption "Syncthing file synchronization";
    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "sync";
      description = "Syncthing administration subdomain";
    };
    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "${config.homelab.mounts.fast}/appdata/syncthing";
      description = "Syncthing configuration and index directory";
    };
    syncDir = lib.mkOption {
      type = lib.types.path;
      default = "${config.homelab.mounts.media}/sources/seedbox";
      description = "Local folder synchronized with the seedbox";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.media = { };

    services.syncthing = {
      enable = true;
      user = "syncthing";
      group = "media";
      dataDir = cfg.dataDir;
      configDir = cfg.dataDir;
      databaseDir = cfg.dataDir;
      guiAddress = "127.0.0.1:8384";
      openDefaultPorts = true;
      overrideDevices = true;
      overrideFolders = true;
      settings = {
        devices = { };
        folders.seedbox = {
          path = "/media/sources/seedbox";
          label = "Seedbox";
          type = "sendreceive";
          devices = [ ];
        };
        options.urAccepted = -1;
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0700 syncthing media - -"
      "Z ${cfg.dataDir} - syncthing media - -"
      "d ${cfg.syncDir} 0770 syncthing media - -"
    ];

    systemd.services.syncthing = {
      unitConfig.RequiresMountsFor = lib.mkAfter [ cfg.syncDir ];
      serviceConfig = {
        InaccessiblePaths = [ config.homelab.mounts.media ];
        BindPaths = [ "${cfg.syncDir}:/media/sources/seedbox" ];
        UMask = "0002";
      };
    };

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:8384";
      auth = true;
      # Keep Syncthing's DNS-rebinding check enabled while proxying its public hostname.
      headerUp.Host = "127.0.0.1:8384";
    };
  };
}
