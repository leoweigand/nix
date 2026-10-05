{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.homelab.apps.pingvin;
  yaml = pkgs.formats.yaml { };
  generatedConfig = yaml.generate "pingvin-config.yaml" cfg.settings;
  configPath = if cfg.configFile != null then "/run/pingvin/config.yaml" else generatedConfig;
in
{
  options.homelab.apps.pingvin = {
    enable = lib.mkEnableOption "Pingvin Share X file sharing";

    image = lib.mkOption {
      type = lib.types.str;
      # v2.0.0 adds HTTP range requests for seeking within shared media.
      default = "ghcr.io/smp46/pingvin-share-x:v2.0.0@sha256:d509135afd1d2cefcdeae64a455d52ad5635f7bb37701c6f858f179023ba2910";
      description = "Pingvin Share X container image, pinned to a release and digest";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3005;
      description = "Loopback port for the Pingvin Share X web interface";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/pingvin";
      description = "Persistent directory for SQLite, uploaded files and custom images";
    };

    uid = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1000;
      description = "UID used inside the container and for persistent file ownership";
    };

    gid = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1000;
      description = "GID used inside the container and for persistent file ownership";
    };

    settings = lib.mkOption {
      type = yaml.type;
      default = { };
      example = {
        general.appUrl = "http://localhost:3005";
        share.defaultExpiration = "7 days";
      };
      description = ''
        Non-secret settings written to config.yaml. Leave empty to configure
        Pingvin in its web interface. Mounting any YAML configuration disables
        the settings editor. Use configFile for a configuration containing secrets.
      '';
    };

    configFile = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "/run/secrets/pingvin-config.yaml";
      description = ''
        Runtime YAML configuration, used instead of settings. This can contain
        secrets and is copied through a systemd credential so its source can
        remain root-readable. The file must exist before the service starts.
      '';
    };
  };

  config = lib.mkMerge [
    {
      # There is no routed URL until a machine declares one explicitly.
      homelab.apps.pingvin.homepage.enable = lib.mkDefault false;
    }
    (lib.mkIf cfg.enable {
      assertions = [
        {
          assertion = lib.hasPrefix "/" cfg.dataDir && cfg.dataDir != "/";
          message = "homelab.apps.pingvin.dataDir must be an absolute directory other than /";
        }
        {
          assertion = cfg.configFile == null || cfg.settings == { };
          message = "Set either homelab.apps.pingvin.settings or configFile, not both";
        }
        {
          assertion = cfg.configFile == null || lib.hasPrefix "/" cfg.configFile;
          message = "homelab.apps.pingvin.configFile must be an absolute runtime path";
        }
      ];

      virtualisation = {
        podman.enable = true;
        oci-containers = {
          backend = "podman";
          containers.pingvin = {
            image = cfg.image;
            autoStart = true;
            ports = [ "127.0.0.1:${toString cfg.port}:3000" ];
            environment = {
              PUID = toString cfg.uid;
              PGID = toString cfg.gid;
              TZ = if config.time.timeZone == null then "UTC" else config.time.timeZone;
              TRUST_PROXY = "false";
            };
            volumes = [
              "${cfg.dataDir}:/opt/app/backend/data"
              "${cfg.dataDir}/images:/opt/app/frontend/public/img"
            ]
            ++ lib.optional (
              cfg.settings != { } || cfg.configFile != null
            ) "${configPath}:/opt/app/config.yaml:ro";
          };
        };
      };

      systemd.tmpfiles.rules = [
        "d ${cfg.dataDir} 0750 ${toString cfg.uid} ${toString cfg.gid} - -"
        "d ${cfg.dataDir}/images 0750 ${toString cfg.uid} ${toString cfg.gid} - -"
      ];

      systemd.services.podman-pingvin = {
        unitConfig.RequiresMountsFor = [ cfg.dataDir ];
        restartTriggers = lib.optional (cfg.settings != { }) generatedConfig;
        serviceConfig = lib.mkIf (cfg.configFile != null) {
          LoadCredential = [ "config.yaml:${cfg.configFile}" ];
          RuntimeDirectory = "pingvin";
          RuntimeDirectoryMode = "0700";
        };
        preStart = lib.mkIf (cfg.configFile != null) (
          lib.mkBefore ''
            ${pkgs.coreutils}/bin/install -m 0400 -o ${toString cfg.uid} -g ${toString cfg.gid} \
              "$CREDENTIALS_DIRECTORY/config.yaml" /run/pingvin/config.yaml
          ''
        );
      };
    })
  ];
}
