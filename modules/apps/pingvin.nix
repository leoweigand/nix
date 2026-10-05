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
  oidcTemplate = pkgs.writeText "pingvin-oidc-template.json" (
    builtins.toJSON (
      lib.recursiveUpdate cfg.settings {
        oauth = {
          allowRegistration = "true";
          disablePassword = "true";
          oidc-enabled = "true";
          oidc-discoveryUri = cfg.oidc.issuerUrl;
          oidc-clientId = cfg.oidc.clientId;
          oidc-scope = "openid email profile groups";
          oidc-usernameClaim = "preferred_username";
          oidc-rolePath = "groups";
          oidc-roleGeneralAccess = cfg.oidc.allowedGroup;
          oidc-roleAdminAccess = cfg.oidc.adminGroup;
        };
        share.allowRegistration = "false";
        share.allowUnauthenticatedShares = "false";
      }
    )
  );
  runtimeConfig = cfg.configFile != null || cfg.oidc.enable;
  configPath = if runtimeConfig then "/run/pingvin/config.yaml" else generatedConfig;
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

    trustProxy = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Trust forwarded request headers when reached through the HTTPS edge";
    };

    oidc = {
      enable = lib.mkEnableOption "native OIDC login with group-based access";
      issuerUrl = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "OIDC issuer or discovery URL";
      };
      clientId = lib.mkOption {
        type = lib.types.str;
        default = "pingvin";
        description = "Confidential OIDC client ID";
      };
      clientSecretReference = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "1Password reference for the OIDC client secret";
      };
      allowedGroup = lib.mkOption {
        type = lib.types.str;
        default = "admins";
        description = "Pocket ID group required to sign in and upload files";
      };
      adminGroup = lib.mkOption {
        type = lib.types.str;
        default = "admins";
        description = "Pocket ID group granting Pingvin administration";
      };
    };

    backupDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional prepared state directory included in the appdata restic job";
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
        {
          assertion =
            !cfg.oidc.enable
            || (
              cfg.configFile == null
              && cfg.oidc.issuerUrl != ""
              && cfg.oidc.clientSecretReference != null
              && cfg.oidc.allowedGroup != ""
              && cfg.oidc.adminGroup != ""
            );
          message = "Pingvin OIDC requires issuerUrl, clientSecretReference and explicit groups; configFile cannot be combined with OIDC";
        }
        {
          assertion =
            cfg.backupDir == null
            || (
              lib.hasPrefix "/" cfg.backupDir
              && cfg.backupDir != "/"
              && cfg.backupDir != cfg.dataDir
              && !(lib.hasPrefix "${cfg.dataDir}/" cfg.backupDir)
              && !(lib.hasPrefix "${cfg.backupDir}/" cfg.dataDir)
            );
          message = "Pingvin backupDir must be an absolute directory outside dataDir";
        }
      ];

      services.onepassword-secrets.secrets = lib.optionalAttrs cfg.oidc.enable {
        pingvinOidcClientSecret = {
          reference = cfg.oidc.clientSecretReference;
          owner = "root";
          group = "root";
          mode = "0400";
        };
      };

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
              TRUST_PROXY = lib.boolToString cfg.trustProxy;
            };
            volumes = [
              "${cfg.dataDir}:/opt/app/backend/data"
              "${cfg.dataDir}/images:/opt/app/frontend/public/img"
            ]
            ++ lib.optional (cfg.settings != { } || runtimeConfig) "${configPath}:/opt/app/config.yaml:ro";
          };
        };
      };

      systemd.tmpfiles.rules = [
        "d ${cfg.dataDir} 0750 ${toString cfg.uid} ${toString cfg.gid} - -"
        "d ${cfg.dataDir}/images 0750 ${toString cfg.uid} ${toString cfg.gid} - -"
      ]
      ++ lib.optionals (cfg.backupDir != null) [
        "d ${cfg.backupDir} 0700 root root - -"
      ];

      systemd.services.podman-pingvin = {
        unitConfig.RequiresMountsFor = [ cfg.dataDir ];
        after = lib.optionals cfg.oidc.enable [ "opnix-secrets.service" ];
        requires = lib.optionals cfg.oidc.enable [ "opnix-secrets.service" ];
        restartTriggers =
          if cfg.oidc.enable then [ oidcTemplate ] else lib.optional (cfg.settings != { }) generatedConfig;
        serviceConfig = lib.mkIf runtimeConfig {
          LoadCredential =
            if cfg.oidc.enable then
              [ "oidc-client-secret:${config.services.onepassword-secrets.secretPaths.pingvinOidcClientSecret}" ]
            else
              [ "config.yaml:${cfg.configFile}" ];
          RuntimeDirectory = "pingvin";
          RuntimeDirectoryMode = "0700";
        };
        preStart = lib.mkIf runtimeConfig (
          lib.mkBefore (
            if cfg.oidc.enable then
              ''
                umask 077
                # JSON is valid YAML; interpolate the credential only at service start.
                ${pkgs.jq}/bin/jq --rawfile secret "$CREDENTIALS_DIRECTORY/oidc-client-secret" \
                  '.oauth["oidc-clientSecret"] = ($secret | rtrimstr("\n"))' \
                  ${oidcTemplate} > /run/pingvin/config.yaml
                ${pkgs.coreutils}/bin/chown ${toString cfg.uid}:${toString cfg.gid} /run/pingvin/config.yaml
                ${pkgs.coreutils}/bin/chmod 0400 /run/pingvin/config.yaml
              ''
            else
              ''
                ${pkgs.coreutils}/bin/install -m 0400 -o ${toString cfg.uid} -g ${toString cfg.gid} \
                  "$CREDENTIALS_DIRECTORY/config.yaml" /run/pingvin/config.yaml
              ''
          )
        );
      };

      systemd.services.pingvin-backup = lib.mkIf (cfg.backupDir != null) {
        description = "Prepare Pingvin state for restic with uploads quiesced";
        unitConfig.RequiresMountsFor = [
          cfg.dataDir
          cfg.backupDir
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
          if systemctl is-active --quiet podman-pingvin.service; then
            was_active=true
            trap 'if "$was_active"; then systemctl start podman-pingvin.service; fi' EXIT
            systemctl stop podman-pingvin.service
          fi
          test -s ${lib.escapeShellArg "${cfg.dataDir}/pingvin-share.db"}
          rsync -a --delete --chmod=D700,F600 --chown=root:root ${lib.escapeShellArg "${cfg.dataDir}/"} ${lib.escapeShellArg "${cfg.backupDir}/"}
          test "$(sqlite3 ${lib.escapeShellArg "${cfg.backupDir}/pingvin-share.db"} 'PRAGMA quick_check;')" = ok
        '';
      };
      homelab.infra.backup.jobs.appdata.prepareCommand =
        lib.mkIf (cfg.backupDir != null && config.homelab.infra.backup.enable)
          (
            lib.mkAfter ''
              ${pkgs.systemd}/bin/systemctl start pingvin-backup.service
            ''
          );
    })
  ];
}
