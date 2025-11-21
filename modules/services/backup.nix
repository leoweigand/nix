{ config, lib, pkgs, ... }:

let
  cfg = config.backup;
  secrets = config.services.onepassword-secrets.secretPaths;
in

{
  options.backup = {
    enable = lib.mkEnableOption "Restic backups to remote storage";

    s3 = {
      endpoint = lib.mkOption {
        type = lib.types.str;
        description = "S3 endpoint URL (e.g., s3.eu-central-003.backblazeb2.com)";
      };

      bucket = lib.mkOption {
        type = lib.types.str;
        description = "S3 bucket name";
      };
    };

    secrets = {
      s3Credentials = lib.mkOption {
        type = lib.types.str;
        description = "1Password reference for S3 credentials";
      };

      resticPassword = lib.mkOption {
        type = lib.types.str;
        description = "1Password reference for restic password";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    services.onepassword-secrets.secrets = {
      s3Credentials = {
        reference = cfg.secrets.s3Credentials;
        owner = "root";
        group = "root";
        mode = "0400";
      };

      resticPassword = {
        reference = cfg.secrets.resticPassword;
        owner = "root";
        group = "root";
        mode = "0400";
      };
    };

    services.postgresqlBackup = {
      enable = config.services.postgresql.enable;
      databases = config.services.postgresql.ensureDatabases;
    };

    services.restic.backups = {
      # Tier 1: Appdata (daily backups)
      appdata-s3 = {
        repository = "s3:${cfg.s3.endpoint}/${cfg.s3.bucket}/appdata";
        initialize = true;
        passwordFile = secrets.resticPassword;
        environmentFile = secrets.s3Credentials;

        paths = [
          config.storage.directories.backup
          config.storage.directories.appdata
        ];

      exclude = [
        "**/log"
        "**/logs"
        "**/index"
        "**/.cache"
        "**/thumbs"
        "**/thumbnails"
      ];

      pruneOpts = [
        "--keep-daily 7"
        "--keep-weekly 4"
        "--keep-monthly 3"
      ];

      timerConfig = {
        OnCalendar = "*-*-* 03:00:00";  # Daily at 3:00 AM
        Persistent = true;  # Run missed backups on boot
      };

      backupPrepareCommand =
        let
          restic = "${pkgs.restic}/bin/restic";
          repo = config.services.restic.backups.appdata-s3.repository;
          passFile = secrets.resticPassword;
        in
        ''
          ${restic} -r ${repo} -p ${passFile} snapshots &>/dev/null || \
            ${restic} -r ${repo} -p ${passFile} init
          ${restic} -r ${repo} -p ${passFile} unlock || true
        '';

      backupCleanupCommand =
        let
          restic = "${pkgs.restic}/bin/restic";
          repo = config.services.restic.backups.appdata-s3.repository;
          passFile = secrets.resticPassword;
        in
        ''
          # Remove old snapshots according to retention policy
          ${restic} -r ${repo} -p ${passFile} forget --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 3
        '';
    };

      # Tier 2: Documents (weekly backups)
      documents-s3 = {
        repository = "s3:${cfg.s3.endpoint}/${cfg.s3.bucket}/documents";
        initialize = true;
        passwordFile = secrets.resticPassword;
        environmentFile = secrets.s3Credentials;

        paths = [
          config.storage.directories.data
        ];

      exclude = [
        "**/thumbs"
        "**/thumbnails"
        "**/.tmp"
        "**/consume"
      ];

      pruneOpts = [
        "--keep-weekly 4"
        "--keep-monthly 6"
      ];

      timerConfig = {
        OnCalendar = "Sun *-*-* 04:00:00";  # Weekly on Sundays at 4:00 AM
        Persistent = true;
      };

      backupPrepareCommand =
        let
          restic = "${pkgs.restic}/bin/restic";
          repo = config.services.restic.backups.documents-s3.repository;
          passFile = secrets.resticPassword;
        in
        ''
          ${restic} -r ${repo} -p ${passFile} snapshots &>/dev/null || \
            ${restic} -r ${repo} -p ${passFile} init
          ${restic} -r ${repo} -p ${passFile} unlock || true
        '';

      backupCleanupCommand =
        let
          restic = "${pkgs.restic}/bin/restic";
          repo = config.services.restic.backups.documents-s3.repository;
          passFile = secrets.resticPassword;
        in
        ''
          # Remove old snapshots according to retention policy
          ${restic} -r ${repo} -p ${passFile} forget --prune --keep-weekly 4 --keep-monthly 6
        '';
    };
  };

      };
    };

    systemd.services.restic-backups-appdata-s3 = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    };

    systemd.services.restic-backups-documents-s3 = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    };

    # Restic wrapper - automatically loads credentials from 1Password
    environment.systemPackages = [
      (pkgs.writeShellScriptBin "restic" ''
        set -euo pipefail
        if [ -f "${secrets.s3Credentials}" ]; then
          source "${secrets.s3Credentials}"
          export RESTIC_PASSWORD_FILE="${secrets.resticPassword}"
        else
          echo "Error: Credentials not found. Run as root."
          exit 1
        fi
        exec ${pkgs.restic}/bin/restic "$@"
      '')
    ];
  };
}
