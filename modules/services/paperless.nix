{ config, lib, ... }:

let
  cfg = config.lab.services.paperless;
  serviceHost = "${cfg.subdomain}.${config.lab.baseDomain}";
in

{
  options.lab.services.paperless = {
    enable = lib.mkEnableOption "Paperless-ngx service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "paperless";
      description = "Subdomain used to build the Paperless URL";
    };

    mediaDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/paperless/media";
      description = "Directory where Paperless stores processed documents";
    };

    consumptionDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/paperless/consume";
      description = "Directory Paperless watches for incoming files";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.lab.baseDomain != "";
        message = "lab.baseDomain must be set when lab.services.paperless.enable = true";
      }
    ];

    services.onepassword-secrets.secrets = {
      paperlessAdminPassword = {
        reference = "op://Homelab/Paperless/adminPassword";
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

      dataDir = lib.mkDefault "/var/lib/paperless";
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

    services.caddy.virtualHosts.${serviceHost} = {
      useACMEHost = config.lab.baseDomain;
      extraConfig = ''
        reverse_proxy http://127.0.0.1:${toString config.services.paperless.port}
      '';
    };

    systemd.tmpfiles.rules = [
      "d /var/lib/paperless 0750 paperless paperless - -"
      "d ${config.services.paperless.mediaDir} 0750 paperless paperless - -"
      "d ${config.services.paperless.consumptionDir} 0750 paperless paperless - -"
    ];

    systemd.services.paperless-scheduler = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    };
  };
}
