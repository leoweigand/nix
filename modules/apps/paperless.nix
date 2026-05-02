{ config, lib, ... }:

let
  name = "paperless";
  cfg = config.homelab.apps.${name};
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
in

{
  options.homelab.apps.${name} = {
    enable = lib.mkEnableOption "Paperless-ngx service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = name;
      description = "Subdomain used to build the Paperless URL";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/paperless";
      description = "Directory where Paperless stores internal application state";
    };

    mediaDir = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.dataDir}/media";
      description = "Directory where Paperless stores processed documents";
    };

    consumptionDir = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.dataDir}/consume";
      description = "Directory Paperless watches for incoming files";
    };

    oidcEnvReference = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "1Password reference to an env file with Paperless OIDC settings";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.${name}.enable = true";
      }
    ];

    services.onepassword-secrets.secrets = {
      paperlessAdminPassword = {
        reference = "op://Homelab/Paperless/adminPassword";
        owner = "paperless";
        group = "paperless";
        mode = "0400";
      };
    } // lib.optionalAttrs (cfg.oidcEnvReference != null) {
      paperlessOidcEnv = {
        reference = cfg.oidcEnvReference;
        owner = "paperless";
        group = "paperless";
        mode = "0400";
      };
    };

    # NixOS 24.05 requires manual PostgreSQL configuration
    services.postgresql = {
      enable = true;
      ensureDatabases = [ "paperless" ];
      ensureUsers = [{
        name = "paperless";
        ensureDBOwnership = true;
      }];
    };

    services.paperless = {
      enable = true;
      passwordFile = config.services.onepassword-secrets.secretPaths.paperlessAdminPassword;

      dataDir = cfg.dataDir;
      mediaDir = cfg.mediaDir;
      consumptionDir = cfg.consumptionDir;

      address = "127.0.0.1";
      port = 28981;
      consumptionDirIsPublic = true;  # Allow all users to add documents

      settings = {
        PAPERLESS_URL = "https://${serviceHost}";
        PAPERLESS_ADMIN_USER = "admin";
        PAPERLESS_TIME_ZONE = "Europe/Berlin";
        PAPERLESS_OCR_LANGUAGE = "eng";
        PAPERLESS_OCR_USER_ARGS = {
          optimize = 1;
          pdfa_image_compression = "lossless";
        };
        PAPERLESS_FILENAME_FORMAT = "{created_year}/{document_type}/{title}";
        PAPERLESS_CONSUMER_IGNORE_PATTERN = [
          ".DS_STORE/*"
          "desktop.ini"
          "._*"
        ];
        PAPERLESS_TASK_WORKERS = 2;
        PAPERLESS_THREADS_PER_WORKER = 2;
      };
    };

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:${toString config.services.paperless.port}";
    };

    # Make paperless's primary group `homelab` so the upstream services.paperless
    # module's own tmpfiles entries (which derive group from this) emit `homelab`,
    # giving leo read access via the shared group. The `paperless` group still
    # exists separately for legacy references (e.g. secrets group ownership).
    users.users.paperless.group = lib.mkForce "homelab";

    # Explicit rules for the parent dirs of mediaDir/consumptionDir.
    # Without these, the parents get implicit/inconsistent ownership and
    # systemd-tmpfiles aborts with "unsafe path transition", silently skipping
    # the rules below them.
    systemd.tmpfiles.rules = [
      "d ${builtins.dirOf (builtins.dirOf config.services.paperless.mediaDir)} 0750 paperless homelab - -"
      "d ${builtins.dirOf config.services.paperless.mediaDir} 0750 paperless homelab - -"
      # Explicit 0750 on mediaDir: upstream's tmpfiles rule uses `-` for mode
      # (don't change), and paperless historically left this dir at 0711.
      "d ${config.services.paperless.mediaDir} 0750 paperless homelab - -"
    ];

    systemd.services.paperless-scheduler = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    } // lib.optionalAttrs (cfg.oidcEnvReference != null) {
      serviceConfig.EnvironmentFile = config.services.onepassword-secrets.secretPaths.paperlessOidcEnv;
    };

    systemd.services.paperless-web = lib.mkIf (cfg.oidcEnvReference != null) {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
      serviceConfig.EnvironmentFile = config.services.onepassword-secrets.secretPaths.paperlessOidcEnv;
    };

    systemd.services.paperless-consumer = lib.mkIf (cfg.oidcEnvReference != null) {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
      serviceConfig.EnvironmentFile = config.services.onepassword-secrets.secretPaths.paperlessOidcEnv;
    };

    systemd.services.paperless-task-queue = lib.mkIf (cfg.oidcEnvReference != null) {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
      serviceConfig.EnvironmentFile = config.services.onepassword-secrets.secretPaths.paperlessOidcEnv;
    };
  };
}
