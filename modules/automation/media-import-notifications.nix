{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.automation.mediaImportNotifications;

  mediaImportNotify = pkgs.writeShellApplication {
    name = "media-import-notify";
    runtimeInputs = [ pkgs.curl pkgs.jq ];
    text = ''
      set -o errexit -o nounset -o pipefail

      if [ -n "''${radarr_eventtype:-}" ]; then
        [ "$radarr_eventtype" = "Test" ] && exit 0
        [ "$radarr_eventtype" = "Download" ] || exit 0
        [ "''${radarr_isupgrade:-False}" = "True" ] && exit 0

        message="New movie: ''${radarr_movie_title:?missing Radarr movie title}"
        if [ -n "''${radarr_movie_year:-}" ]; then
          message="$message ($radarr_movie_year)"
        fi
      elif [ -n "''${sonarr_eventtype:-}" ]; then
        [ "$sonarr_eventtype" = "Test" ] && exit 0
        [ "$sonarr_eventtype" = "Download" ] || exit 0
        [ "''${sonarr_isupgrade:-False}" = "True" ] && exit 0

        message="New TV: ''${sonarr_series_title:?missing Sonarr series title} — Season ''${sonarr_episodefile_seasonnumber:?missing Sonarr season number}"
      else
        exit 0
      fi

      jq --null-input --arg message "$message" '{ message: $message }' |
        curl --fail --silent --show-error --retry 2 --retry-delay 2 \
          --request POST \
          --header 'Content-Type: application/json' \
          --data-binary @- \
          ${lib.escapeShellArg cfg.endpoint}
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
  };
}
