{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.automation.mediaImportNotifications;

  mediaImportNotify = pkgs.writeShellApplication {
    name = "media-import-notify";
    runtimeInputs = [ pkgs.curl pkgs.jq ];
    text = ''
      set -o errexit -o nounset -o pipefail

      strip_trailing_year() {
        title="$1"
        if [[ "$title" =~ ^(.*)[[:space:]]\([0-9]{4}\)$ ]]; then
          title="''${BASH_REMATCH[1]}"
        fi
      }

      if [ -n "''${radarr_eventtype:-}" ]; then
        [ "$radarr_eventtype" = "Test" ] && exit 0
        [ "$radarr_eventtype" = "Download" ] || exit 0
        [ "''${radarr_isupgrade:-False}" = "True" ] && exit 0

        strip_trailing_year "''${radarr_movie_title:?missing Radarr movie title}"
        message="🎬 New movie: $title"
      elif [ -n "''${sonarr_eventtype:-}" ]; then
        [ "$sonarr_eventtype" = "Test" ] && exit 0
        [ "$sonarr_eventtype" = "Download" ] || exit 0
        [ "''${sonarr_isupgrade:-False}" = "True" ] && exit 0

        season="''${sonarr_episodefile_seasonnumber:?missing Sonarr season number}"
        episodes="''${sonarr_episodefile_episodenumbers:?missing Sonarr episode numbers}"
        episode_label=$(jq --null-input --raw-output \
          --arg season "$season" --arg episodes "$episodes" '
          def pad: if length < 2 then "0" + . else . end;
          ($season | pad) as $season_number |
          ($episodes | split(",") | map("E" + pad) | join(", ")) as $episode_numbers |
          "S" + $season_number + $episode_numbers
        ')
        strip_trailing_year "''${sonarr_series_title:?missing Sonarr series title}"
        message="📺 New TV: $title — $episode_label"
      else
        exit 0
      fi

      jq --null-input --arg message "$message" '{ to: "kittypurr", message: $message }' |
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
