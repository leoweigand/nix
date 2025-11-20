{ config, lib, pkgs, ... }:

{
  # ============================================================================
  # Restic Backups to Backblaze B2
  # ============================================================================
  #
  # Purpose: Dual-tier backup strategy for homelab services
  # Backend: Backblaze B2 (using S3-compatible API)
  #
  # Backup Tiers:
  #   Tier 1 (appdata): Daily backups of config, state, and database dumps
  #     - /var/backup/postgresql/ (database dumps)
  #     - /var/lib/paperless/data/ (app state, models, NOT documents)
  #     Schedule: Daily at 3:00 AM
  #     Retention: 7 daily, 4 weekly, 3 monthly
  #
  #   Tier 2 (documents): Weekly backups of large media files
  #     - /mnt/data/paperless/ (original documents, archived PDFs)
  #     Schedule: Weekly on Sunday at 4:00 AM
  #     Retention: 4 weekly, 6 monthly

  #
  # Secrets (via OpNix):
  #   - op://Homelab/Backblaze Backup/s3Credentials
  #     Must contain (environment file format):
  #       AWS_ACCESS_KEY_ID=xxx
  #       AWS_SECRET_ACCESS_KEY=yyy
  #       AWS_DEFAULT_REGION=us-west-004
  #   - op://Homelab/Backblaze Backup/resticPassword
  #
  # Recovery:
  #   export AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy AWS_DEFAULT_REGION=us-west-004
  #   restic -r s3:s3.us-west-004.backblazeb2.com/riker-backups/appdata snapshots
  #   restic -r s3:s3.us-west-004.backblazeb2.com/riker-backups/appdata restore latest --target /tmp/restore
  #
  # ============================================================================

  # --------------------------------------------------------------------------
  # Secret Management
  # --------------------------------------------------------------------------
  services.onepassword-secrets.secrets = {
    # S3 credentials for Backblaze B2 (contains AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION)
    s3Credentials = {
      reference = "op://Homelab/Backblaze Backup/s3Credentials";
      owner = "root";
      group = "root";
      mode = "0400";
    };

    # Restic repository password
    resticPassword = {
      reference = "op://Homelab/Backblaze Backup/resticPassword";
      owner = "root";
      group = "root";
      mode = "0400";
    };
  };

  # --------------------------------------------------------------------------
  # PostgreSQL Database Backups
  # --------------------------------------------------------------------------
  # Automatically dumps all PostgreSQL databases to /var/backup/postgresql/
  # These dumps are then backed up by the appdata restic job
  services.postgresqlBackup = {
    enable = config.services.postgresql.enable;
    databases = config.services.postgresql.ensureDatabases;
    # Backups are stored in /var/backup/postgresql/ by default
    # Each database gets a separate .sql.gz file
  };

  # --------------------------------------------------------------------------
  # Restic Backup Jobs
  # --------------------------------------------------------------------------
  services.restic.backups = {

    # ------------------------------------------------------------------------
    # Tier 1: Appdata (Config, State, Database Dumps)
    # ------------------------------------------------------------------------
    appdata-s3 = {
      # Repository configuration
      # Format: s3:ENDPOINT/BUCKET/PREFIX (following Wolfgang's pattern)
      # ENDPOINT and BUCKET are in the URL, credentials come from environmentFile
      repository = "s3:s3.us-west-004.backblazeb2.com/riker-backup/appdata";
      initialize = true;
      passwordFile = config.services.onepassword-secrets.secretPaths.resticPassword;

      # S3 credentials loaded from environment file
      # Must include: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION
      environmentFile = config.services.onepassword-secrets.secretPaths.s3Credentials;

      # What to backup
      paths = [
        "/var/backup"                     # PostgreSQL dumps
        "/var/lib/paperless/data"         # Paperless app state (NOT documents)
      ];

      # What NOT to backup
      exclude = [
        "/var/lib/paperless/data/log"    # Logs (not needed for recovery)
        "/var/lib/paperless/data/index"  # Search index (regenerable)
        "**/.cache"                       # Cache directories
        "**/thumbs"                       # Thumbnails (regenerable)
      ];

      # Retention policy
      pruneOpts = [
        "--keep-daily 7"      # Last 7 days
        "--keep-weekly 4"     # Last 4 weeks
        "--keep-monthly 3"    # Last 3 months
      ];

      # Schedule: Daily at 3:00 AM
      timerConfig = {
        OnCalendar = "*-*-* 03:00:00";
        Persistent = true;  # Run missed backups on boot
      };

      # Prepare backup (initialize repo if needed)
      backupPrepareCommand =
        let
          restic = "${pkgs.restic}/bin/restic";
          repo = config.services.restic.backups.appdata-s3.repository;
          passFile = config.services.onepassword-secrets.secretPaths.resticPassword;
        in
        ''
          # Initialize repository if it doesn't exist
          ${restic} -r ${repo} -p ${passFile} snapshots &>/dev/null || \
            ${restic} -r ${repo} -p ${passFile} init

          # Unlock repository in case of previous failure
          ${restic} -r ${repo} -p ${passFile} unlock || true
        '';

      # After backup: prune old snapshots
      backupCleanupCommand =
        let
          restic = "${pkgs.restic}/bin/restic";
          repo = config.services.restic.backups.appdata-s3.repository;
          passFile = config.services.onepassword-secrets.secretPaths.resticPassword;
        in
        ''
          # Prune old snapshots according to retention policy
          ${restic} -r ${repo} -p ${passFile} forget --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 3
        '';
    };

    # ------------------------------------------------------------------------
    # Tier 2: Documents (Large Media Files)
    # ------------------------------------------------------------------------
    documents-s3 = {
      # Repository configuration
      # Format: s3:ENDPOINT/BUCKET/PREFIX (following Wolfgang's pattern)
      # ENDPOINT and BUCKET are in the URL, credentials come from environmentFile
      repository = "s3:s3.us-west-004.backblazeb2.com/riker-backup/documents";
      initialize = true;
      passwordFile = config.services.onepassword-secrets.secretPaths.resticPassword;

      # S3 credentials loaded from environment file
      # Must include: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION
      environmentFile = config.services.onepassword-secrets.secretPaths.s3Credentials;

      # What to backup
      paths = [
        "/mnt/data/paperless"  # Paperless documents (originals + archives)
      ];

      # What NOT to backup
      exclude = [
        "**/thumbs"            # Thumbnails (regenerable)
        "**/.tmp"              # Temporary files
        "**/consume"           # In-flight processing directory
      ];

      # Retention policy (less aggressive for large data)
      pruneOpts = [
        "--keep-weekly 4"     # Last 4 weeks
        "--keep-monthly 6"    # Last 6 months
      ];

      # Schedule: Weekly on Sunday at 4:00 AM
      timerConfig = {
        OnCalendar = "Sun *-*-* 04:00:00";
        Persistent = true;
      };

      # Prepare backup
      backupPrepareCommand =
        let
          restic = "${pkgs.restic}/bin/restic";
          repo = config.services.restic.backups.documents-s3.repository;
          passFile = config.services.onepassword-secrets.secretPaths.resticPassword;
        in
        ''
          # Initialize repository if it doesn't exist
          ${restic} -r ${repo} -p ${passFile} snapshots &>/dev/null || \
            ${restic} -r ${repo} -p ${passFile} init

          # Unlock repository
          ${restic} -r ${repo} -p ${passFile} unlock || true
        '';

      # After backup: prune old snapshots
      backupCleanupCommand =
        let
          restic = "${pkgs.restic}/bin/restic";
          repo = config.services.restic.backups.documents-s3.repository;
          passFile = config.services.onepassword-secrets.secretPaths.resticPassword;
        in
        ''
          # Prune old snapshots
          ${restic} -r ${repo} -p ${passFile} forget --prune --keep-weekly 4 --keep-monthly 6
        '';
    };
  };

  # --------------------------------------------------------------------------
  # Service Dependencies
  # --------------------------------------------------------------------------
  # Ensure backup services wait for secrets to be available
  # S3 credentials are loaded from environmentFile
  systemd.services.restic-backups-appdata-s3 = {
    after = [ "opnix-secrets.service" ];
    requires = [ "opnix-secrets.service" ];
  };

  systemd.services.restic-backups-documents-s3 = {
    after = [ "opnix-secrets.service" ];
    requires = [ "opnix-secrets.service" ];
  };
}
