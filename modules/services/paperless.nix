{ config, lib, pkgs, ... }:

{
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
    mediaDir = lib.mkDefault "/var/lib/paperless/media";
    consumptionDir = lib.mkDefault "/var/lib/paperless/consume";

    address = "0.0.0.0";
    port = 28981;
    consumptionDirIsPublic = true;  # Allow all users to add documents

    settings = {
      PAPERLESS_URL = "http://${config.networking.hostName}:28981";
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

  systemd.tmpfiles.rules = [
    "d /var/lib/paperless 0750 paperless paperless - -"
    "d ${config.services.paperless.mediaDir} 0750 paperless paperless - -"
    "d ${config.services.paperless.consumptionDir} 0750 paperless paperless - -"
  ];

  systemd.services.paperless-scheduler = {
    after = [ "opnix-secrets.service" ];
    requires = [ "opnix-secrets.service" ];
  };
}
