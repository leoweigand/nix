{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.homelab.infra.pocketId;
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
  backupScript = pkgs.writeShellScript "pocket-id-backup" ''
    set -euo pipefail
    umask 077
    ${pkgs.sqlite}/bin/sqlite3 ${lib.escapeShellArg "${cfg.dataDir}/pocket-id.db"} \
      ".timeout 30000" ".backup '${cfg.backupDir}/pocket-id.db.tmp'"
    test "$(${pkgs.sqlite}/bin/sqlite3 ${lib.escapeShellArg "${cfg.backupDir}/pocket-id.db.tmp"} 'PRAGMA quick_check;')" = ok
    ${pkgs.coreutils}/bin/mv ${lib.escapeShellArg "${cfg.backupDir}/pocket-id.db.tmp"} ${lib.escapeShellArg "${cfg.backupDir}/pocket-id.db"}
    ${pkgs.rsync}/bin/rsync -a --delete ${lib.escapeShellArg "${cfg.dataDir}/uploads/"} ${lib.escapeShellArg "${cfg.backupDir}/uploads/"}
  '';
in
{
  options.homelab.infra.pocketId = {
    enable = lib.mkEnableOption "Pocket ID passkey identity provider";
    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "id";
      description = "Permanent hostname for Pocket ID; passkeys are bound to this domain";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 1411;
      description = "Loopback port for Pocket ID";
    };
    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/pocket-id";
      description = "Local-disk state directory; SQLite must not run on a shared filesystem";
    };
    encryptionKeyReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference to the persistent encryption key";
    };
    backupDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/appdata/pocket-id-backup";
      description = "Consistent SQLite snapshot and uploads included in the appdata backup";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.infra.edge.enable && config.homelab.baseDomain != "";
        message = "Pocket ID requires the HTTPS edge and a base domain";
      }
      {
        assertion =
          cfg.dataDir != config.homelab.mounts.fast
          && !(lib.hasPrefix "${config.homelab.mounts.fast}/" cfg.dataDir);
        message = "Pocket ID's live SQLite database must use local disk, not the fast shared mount";
      }
    ];

    services.onepassword-secrets.secrets.pocketIdEncryptionKey = {
      reference = cfg.encryptionKeyReference;
      owner = "root";
      group = "root";
      mode = "0400";
    };
    services.pocket-id = {
      enable = true;
      dataDir = cfg.dataDir;
      credentials.ENCRYPTION_KEY = config.services.onepassword-secrets.secretPaths.pocketIdEncryptionKey;
      settings = {
        APP_URL = "https://${serviceHost}";
        HOST = "127.0.0.1";
        PORT = cfg.port;
        TRUST_PROXY = true;
        DB_CONNECTION_STRING = "${cfg.dataDir}/pocket-id.db";
        UPLOAD_PATH = "${cfg.dataDir}/uploads";
        ANALYTICS_DISABLED = true;
        UI_CONFIG_DISABLED = true;
        ALLOW_USER_SIGNUPS = "disabled";
        EMAILS_VERIFIED = true;
        ALLOW_OWN_ACCOUNT_EDIT = false;
        ALLOW_INSECURE_CALLBACK_URLS = false;
      };
    };
    systemd.services.pocket-id = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    };
    systemd.services.pocket-id-backup = {
      description = "Prepare a consistent Pocket ID database for restic";
      serviceConfig = {
        Type = "oneshot";
        ExecStart = backupScript;
      };
    };
    homelab.infra.edge.proxies.${cfg.subdomain}.upstream = "http://127.0.0.1:${toString cfg.port}";

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir}/uploads 0700 pocket-id pocket-id - -"
      "d ${cfg.backupDir} 0700 root root - -"
    ];
    homelab.infra.backup.jobs.appdata.prepareCommand = lib.mkIf config.homelab.infra.backup.enable (
      lib.mkAfter ''
        ${pkgs.systemd}/bin/systemctl start pocket-id-backup.service
      ''
    );
  };
}
