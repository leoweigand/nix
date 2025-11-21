{ config, lib, pkgs, ... }:

let
  storage = config.storage;
in

{
  services.onepassword-secrets.secrets = {
    s3Credentials = {
      reference = "op://Homelab/Backblaze Backup/s3Credentials";
      owner = "root";
      group = "root";
      mode = "0400";
    };

    resticPassword = {
      reference = "op://Homelab/Backblaze Backup/resticPassword";
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
      repository = "s3:s3.eu-central-003.backblazeb2.com/leolab-backup/appdata";
      initialize = true;
      passwordFile = config.services.onepassword-secrets.secretPaths.resticPassword;
      environmentFile = config.services.onepassword-secrets.secretPaths.s3Credentials;

      paths = [
        storage.directories.backup
        storage.directories.appdata
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
          passFile = config.services.onepassword-secrets.secretPaths.resticPassword;
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
          passFile = config.services.onepassword-secrets.secretPaths.resticPassword;
        in
        ''
          # Remove old snapshots according to retention policy
          ${restic} -r ${repo} -p ${passFile} forget --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 3
        '';
    };

    # Tier 2: Documents (weekly backups)
    documents-s3 = {
      repository = "s3:s3.eu-central-003.backblazeb2.com/leolab-backup/documents";
      initialize = true;
      passwordFile = config.services.onepassword-secrets.secretPaths.resticPassword;
      environmentFile = config.services.onepassword-secrets.secretPaths.s3Credentials;

      paths = [
        storage.directories.data
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
          passFile = config.services.onepassword-secrets.secretPaths.resticPassword;
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
          passFile = config.services.onepassword-secrets.secretPaths.resticPassword;
        in
        ''
          # Remove old snapshots according to retention policy
          ${restic} -r ${repo} -p ${passFile} forget --prune --keep-weekly 4 --keep-monthly 6
        '';
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
      if [ -f "${config.services.onepassword-secrets.secretPaths.s3Credentials}" ]; then
        source "${config.services.onepassword-secrets.secretPaths.s3Credentials}"
        export RESTIC_PASSWORD_FILE="${config.services.onepassword-secrets.secretPaths.resticPassword}"
      else
        echo "Error: Credentials not found. Run as root."
        exit 1
      fi
      exec ${pkgs.restic}/bin/restic "$@"
    '')
  ];
}
