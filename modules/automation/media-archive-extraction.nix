{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.automation.mediaArchiveExtraction;
  apps = lib.filter (name: config.homelab.apps.${name}.enable) [ "sonarr" "radarr" ];
  inbox = name: "/media/sources/seedbox/deluge/${name}";
in
{
  options.homelab.automation.mediaArchiveExtraction.enable =
    lib.mkEnableOption "archive extraction for synchronised Arr downloads";

  config = lib.mkIf cfg.enable {
    assertions = [ {
      assertion = apps != [ ];
      message = "Media archive extraction needs Sonarr or Radarr";
    } ];

    services.unpackerr = {
      enable = true;
      group = "media";
      settings = {
        interval = "1m";
        start_delay = "1m";
        file_mode = "0664";
        dir_mode = "0775";
        webserver.listen_addr = "";
      } // lib.genAttrs apps (name: [ {
        url = "http://127.0.0.1:${toString config.services.${name}.settings.server.port}";
        api_key = "filepath:/run/unpackerr/${name}-api-key";
        paths = [ (inbox name) ];
        protocols = "torrent,TorrentDownloadProtocol";
        syncthing = true;
        # Only disposable extracted copies are removed, after Arr imports them.
        delete_orig = false;
        delete_delay = "5m";
      } ]);
    };

    systemd.services.unpackerr = {
      wants = map (name: "${name}.service") apps;
      after = map (name: "${name}.service") apps;
      unitConfig.RequiresMountsFor = lib.concatMap (name: [
        config.homelab.apps.${name}.dataDir
        config.homelab.apps.${name}.downloadDir
      ]) apps;
      # Load the existing Arr keys at runtime; no credentials enter the Nix store.
      preStart = lib.concatMapStringsSep "\n" (name: ''
        ${pkgs.libxml2}/bin/xmllint --xpath 'string(/Config/ApiKey)' \
          "$CREDENTIALS_DIRECTORY/${name}-config" > /run/unpackerr/${name}-api-key
        test -s /run/unpackerr/${name}-api-key
        chmod 600 /run/unpackerr/${name}-api-key
      '') apps;
      environment.HOME = "/var/lib/unpackerr";
      serviceConfig = {
        RuntimeDirectory = "unpackerr";
        RuntimeDirectoryMode = "0700";
        StateDirectory = "unpackerr";
        StateDirectoryMode = "0700";
        LoadCredential = map (name:
          "${name}-config:${config.homelab.apps.${name}.dataDir}/config.xml"
        ) apps;
        InaccessiblePaths = [ config.homelab.mounts.media config.homelab.mounts.fast ];
        BindPaths = map (name:
          "${config.homelab.apps.${name}.downloadDir}:${inbox name}"
        ) apps;
        UMask = "0002";
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        NoNewPrivileges = true;
      };
    };
  };
}
