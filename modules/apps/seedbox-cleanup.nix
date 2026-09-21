{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.apps.seedboxCleanup;
in
{
  options.homelab.apps.seedboxCleanup = {
    enable = lib.mkEnableOption "SeedHost import and tracker-aware cleanup";
    apply = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Remove eligible torrents; false records decisions without deleting";
    };
  };

  config = lib.mkIf cfg.enable {
    services.onepassword-secrets.secrets.seedboxDelugePassword = {
      reference = "op://Homelab/Deluge/password";
      owner = "root";
    };
    systemd.services.seedbox-cleanup = {
      description = "Verify tracker obligations and library copies before SeedHost cleanup";
      after = [ "network-online.target" "sonarr.service" "radarr.service" "prowlarr.service" "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
      wants = [ "network-online.target" ];
      unitConfig.RequiresMountsFor = [ config.homelab.mounts.media config.homelab.mounts.fast ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${pkgs.python3}/bin/python3 ${./seedbox-cleanup.py} --deluge-password-file ${config.services.onepassword-secrets.secretPaths.seedboxDelugePassword}${lib.optionalString cfg.apply " --apply"}";
        StateDirectory = "seedbox-cleanup";
        StateDirectoryMode = "0700";
        UMask = "0077";
        TimeoutStartSec = "45min";
        Nice = 10;
        IOSchedulingClass = "idle";
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
        RestrictSUIDSGID = true;
        # Deletion is a remote Deluge API call. Local library files are read-only.
        ReadOnlyPaths = [ config.homelab.mounts.media config.homelab.mounts.fast ];
      };
    };
    systemd.timers.seedbox-cleanup = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "2min";
        OnUnitInactiveSec = "15min";
      };
    };
  };
}
