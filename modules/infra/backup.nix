{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.infra.backup;
  secrets = config.services.onepassword-secrets.secretPaths;

  mkResticJob = name: job:
    let
      repository = "s3:${cfg.s3.endpoint}/${cfg.s3.bucket}/${job.repositorySubdir}";
      restic = "${pkgs.restic}/bin/restic";
      retentionArgs = lib.concatStringsSep " " job.pruneOpts;
    in
    {
      inherit repository;
      initialize = true;
      passwordFile = secrets.resticPassword;
      environmentFile = secrets.s3Credentials;
      paths = job.paths;
      exclude = job.exclude;
      pruneOpts = job.pruneOpts;

      timerConfig = {
        OnCalendar = job.schedule;
        Persistent = true;  # Run missed backups on boot
      };

      backupPrepareCommand = ''
        ${restic} -r ${repository} -p ${secrets.resticPassword} snapshots &>/dev/null || \
          ${restic} -r ${repository} -p ${secrets.resticPassword} init
        ${restic} -r ${repository} -p ${secrets.resticPassword} unlock || true
      '';

      backupCleanupCommand = ''
        # Remove old snapshots according to retention policy
        ${restic} -r ${repository} -p ${secrets.resticPassword} forget --prune ${retentionArgs}
      '';
    };
in

{
  options.homelab.infra.backup = {
    enable = lib.mkEnableOption "Restic backups to remote storage";

    s3 = {
      endpoint = lib.mkOption {
        type = lib.types.str;
        description = "S3 endpoint URL (e.g., s3.eu-central-003.backblazeb2.com)";
      };

      bucket = lib.mkOption {
        type = lib.types.str;
        description = "S3 bucket name (machine-specific bucket recommended)";
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

    jobs = lib.mkOption {
      description = "Backup job definitions per machine";
      default = { };
      type = lib.types.attrsOf (lib.types.submodule ({ name, ... }: {
        options = {
          repositorySubdir = lib.mkOption {
            type = lib.types.str;
            default = name;
            description = "Subdirectory inside the machine bucket used as the restic repository prefix";
          };

          schedule = lib.mkOption {
            type = lib.types.str;
            description = "Systemd OnCalendar schedule for the backup timer";
          };

          paths = lib.mkOption {
            type = lib.types.listOf lib.types.path;
            description = "Paths included in this backup job";
          };

          exclude = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [ ];
            description = "Restic exclude patterns for this job";
          };

          pruneOpts = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            description = "Restic prune retention flags (e.g. --keep-daily 7)";
          };
        };
      }));
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.jobs != { };
        message = "homelab.infra.backup.jobs must define at least one backup job when homelab.infra.backup.enable = true";
      }
    ];

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

    services.restic.backups = lib.mapAttrs mkResticJob cfg.jobs;

    systemd.services = lib.mapAttrs' (
      name: _job: lib.nameValuePair "restic-backups-${name}" {
        after = [ "opnix-secrets.service" ];
        requires = [ "opnix-secrets.service" ];
      }
    ) cfg.jobs;

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
