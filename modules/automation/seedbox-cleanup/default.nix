{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.automation.seedboxCleanup;
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
    assertions = [{
      assertion = cfg.environmentReference != "";
      message = "homelab.automation.seedboxCleanup.environmentReference must be set when cleanup is enabled";
    }];

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
      after = [ "network-online.target" "sonarr.service" "radarr.service" "prowlarr.service" "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
      wants = [ "network-online.target" ];
      unitConfig.RequiresMountsFor = [ config.homelab.mounts.media config.homelab.mounts.fast ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${pkgs.deno}/bin/deno run --no-prompt --no-check --frozen --config=${../../../deno.json} --lock=${../../../deno.lock} --allow-env=SEEDBOX_DELUGE_URL,SEEDBOX_COMPLETED_PATH --allow-read=${config.homelab.mounts.media},${config.homelab.mounts.fast},${config.services.onepassword-secrets.secretPaths.seedboxDelugePassword},/var/lib/seedbox-cleanup --allow-write=/var/lib/seedbox-cleanup --allow-net=127.0.0.1:7878,127.0.0.1:8989,tiny.seedhost.eu:443,www.torrentleech.org:443 ${./seedbox-cleanup.ts} --deluge-password-file ${config.services.onepassword-secrets.secretPaths.seedboxDelugePassword}${lib.optionalString cfg.apply " --apply"}";
        EnvironmentFile = config.services.onepassword-secrets.secretPaths.seedboxCleanupEnv;
        StateDirectory = "seedbox-cleanup";
        StateDirectoryMode = "0700";
        UMask = "0077";
        Environment = "DENO_DIR=/var/lib/seedbox-cleanup/deno";
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
        OnCalendar = "*-*-* 03:00:00"; # Daily at 3:00 AM
        Persistent = true;
      };
    };
  };
}
