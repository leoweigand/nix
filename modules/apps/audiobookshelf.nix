{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.homelab.apps.audiobookshelf;
  mediaDir = config.homelab.mounts.media;
  stateDir = "/var/lib/${config.services.audiobookshelf.dataDir}";
in
{
  options.homelab.apps.audiobookshelf = {
    enable = lib.mkEnableOption "Audiobookshelf audiobook and podcast server";
    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "audiobookshelf";
      description = "Audiobookshelf subdomain";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 8000;
      description = "Audiobookshelf loopback port";
    };
  };

  config = lib.mkIf cfg.enable {
    services.audiobookshelf = {
      enable = true;
      host = "127.0.0.1";
      port = cfg.port;
    };

    users.groups.media = { };
    users.users.audiobookshelf.extraGroups = [ "media" ];
    systemd.tmpfiles.rules = [
      "d ${mediaDir}/library/audiobooks 2770 audiobookshelf media - -"
      "d ${mediaDir}/library/podcasts 2770 audiobookshelf media - -"
      "d ${config.homelab.mounts.fast}/appdata/audiobookshelf-backup 0700 root root - -"
    ];
    systemd.services.audiobookshelf = {
      unitConfig.RequiresMountsFor = [
        "${mediaDir}/library/audiobooks"
        "${mediaDir}/library/podcasts"
      ];
      serviceConfig = {
        UMask = "0027";
        KillSignal = "SIGINT"; # Audiobookshelf flushes its database on SIGINT.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        InaccessiblePaths = [ mediaDir ];
        BindPaths = [
          "${mediaDir}/library/audiobooks:/media/audiobooks"
          "${mediaDir}/library/podcasts:/media/podcasts"
        ];
        ReadWritePaths = [
          "/media/audiobooks"
          "/media/podcasts"
        ];
      };
    };

    # Keep SQLite on native storage; copy consistent state into the restic tree.
    systemd.services.audiobookshelf-backup = {
      description = "Prepare quiesced Audiobookshelf state for restic";
      unitConfig.RequiresMountsFor = [
        stateDir
        "${config.homelab.mounts.fast}/appdata/audiobookshelf-backup"
      ];
      serviceConfig.Type = "oneshot";
      path = [
        pkgs.systemd
        pkgs.rsync
        pkgs.sqlite
      ];
      script = ''
        set -euo pipefail
        umask 077
        was_active=false
        if systemctl is-active --quiet audiobookshelf.service; then
          was_active=true
          trap 'if "$was_active"; then systemctl start audiobookshelf.service; fi' EXIT
          systemctl stop audiobookshelf.service
        fi
        test -s ${stateDir}/config/absdatabase.sqlite
        rsync -a --delete --chmod=D700,F600 --chown=root:root \
          --exclude=/metadata/cache --exclude=/metadata/streams \
          ${stateDir}/ ${config.homelab.mounts.fast}/appdata/audiobookshelf-backup/
        test "$(sqlite3 ${config.homelab.mounts.fast}/appdata/audiobookshelf-backup/config/absdatabase.sqlite 'PRAGMA quick_check;')" = ok
      '';
    };
    homelab.infra.backup.jobs.appdata.prepareCommand = lib.mkIf config.homelab.infra.backup.enable (
      lib.mkAfter ''
        ${pkgs.systemd}/bin/systemctl start audiobookshelf-backup.service
      ''
    );

    homelab.infra.edge.proxies.${cfg.subdomain}.upstream = "http://127.0.0.1:${toString cfg.port}";
  };
}
