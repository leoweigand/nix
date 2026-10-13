{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.homelab.automation.seedboxCleanup;
  launcher = pkgs.callPackage ../../../packages/automation/launcher.nix { } {
    name = "seedbox-cleanup";
    script = "modules/automation/seedbox-cleanup/seedbox-cleanup.ts";
    connectPorts = [
      443
      7878
      8989
    ];
    environmentNames = [
      "SEEDBOX_DELUGE_URL"
      "SEEDBOX_COMPLETED_PATH"
    ];
    readPaths = [
      "${config.homelab.mounts.fast}/appdata/sonarr/config.xml"
      "${config.homelab.mounts.fast}/appdata/radarr/config.xml"
      "${config.homelab.mounts.fast}/appdata/prowlarr"
      "${config.homelab.mounts.media}/library/tv"
      "${config.homelab.mounts.media}/library/films"
      "${config.homelab.mounts.media}/sources/seedbox/deluge/sonarr"
      "${config.homelab.mounts.media}/sources/seedbox/deluge/radarr"
      config.services.onepassword-secrets.secretPaths.seedboxDelugePassword
    ];
    writePaths = [ "/var/lib/seedbox-cleanup" ];
  };
in
{
  options.homelab.automation.seedboxCleanup = {
    enable = lib.mkEnableOption "SeedHost import and tracker-aware cleanup";

    environmentReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference to the private SeedHost URL and completed-download root";
      example = "op://Homelab/Seedbox Cleanup/env";
    };

    apply = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Remove eligible torrents; false records decisions without deleting";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.environmentReference != "";
        message = "homelab.automation.seedboxCleanup.environmentReference must be set when cleanup is enabled";
      }
    ];

    services.onepassword-secrets.secrets.seedboxDelugePassword = {
      reference = "op://Homelab/Deluge/password";
      owner = "root";
    };
    services.onepassword-secrets.secrets.seedboxCleanupEnv = {
      reference = cfg.environmentReference;
      owner = "root";
      mode = "0400";
    };
    systemd.services.seedbox-cleanup = {
      description = "Verify tracker obligations and library copies before SeedHost cleanup";
      after = [
        "network-online.target"
        "sonarr.service"
        "radarr.service"
        "prowlarr.service"
        "opnix-secrets.service"
      ];
      requires = [ "opnix-secrets.service" ];
      wants = [ "network-online.target" ];
      unitConfig.RequiresMountsFor = [
        config.homelab.mounts.media
        config.homelab.mounts.fast
      ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${launcher}/bin/seedbox-cleanup --deluge-password-file ${config.services.onepassword-secrets.secretPaths.seedboxDelugePassword}${lib.optionalString cfg.apply " --apply"}";
        EnvironmentFile = config.services.onepassword-secrets.secretPaths.seedboxCleanupEnv;
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
        ReadOnlyPaths = [
          config.homelab.mounts.media
          config.homelab.mounts.fast
        ];
      };
    };
    systemd.timers.seedbox-cleanup = {
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "5min";
        OnUnitInactiveSec = "15min";
      };
    };
  };
}
