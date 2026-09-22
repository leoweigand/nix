{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.automation.mediaImportNotifications;

  mediaImportNotify = pkgs.writeShellApplication {
    name = "media-import-notify";
    runtimeInputs = [ pkgs.deno ];
    text = ''
      export MEDIA_IMPORT_NOTIFICATION_ENDPOINT=${lib.escapeShellArg cfg.endpoint}
      exec deno run --no-prompt \
        --allow-env=MEDIA_IMPORT_NOTIFICATION_ENDPOINT,radarr_eventtype,radarr_isupgrade,radarr_movie_title,sonarr_eventtype,sonarr_isupgrade,sonarr_series_title,sonarr_episodefile_seasonnumber,sonarr_episodefile_episodenumbers,Radarr_EventType,Radarr_IsUpgrade,Radarr_Movie_Title,Sonarr_EventType,Sonarr_IsUpgrade,Sonarr_Series_Title,Sonarr_EpisodeFile_SeasonNumber,Sonarr_EpisodeFile_EpisodeNumbers \
        --allow-net=notifications.${config.homelab.baseDomain}:443 \
        ${./media-import-notifications.ts}
    '';
  };
in
{
  options.homelab.automation.mediaImportNotifications = {
    enable = lib.mkEnableOption "Radarr and Sonarr import notifications";

    endpoint = lib.mkOption {
      type = lib.types.str;
      default = "https://notifications.${config.homelab.baseDomain}/v1/notifications";
      description = "Private notification-gateway endpoint for completed media imports";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.infra.notificationGateway.enable;
        message = "homelab.automation.mediaImportNotifications.enable requires homelab.infra.notificationGateway.enable";
      }
    ];

    environment.systemPackages = [ mediaImportNotify ];

    # Deno's V8 runtime uses memory-protection keys on x86_64 Linux.
    systemd.services.radarr.serviceConfig.SystemCallFilter = lib.mkAfter [
      "pkey_alloc"
      "pkey_free"
      "pkey_mprotect"
    ];
    systemd.services.sonarr.serviceConfig.SystemCallFilter = lib.mkAfter [
      "pkey_alloc"
      "pkey_free"
      "pkey_mprotect"
    ];
  };
}
