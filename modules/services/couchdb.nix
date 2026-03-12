{ config, lib, ... }:

let
  cfg = config.lab.services.couchdb;
  serviceHost = "${cfg.subdomain}.${config.lab.baseDomain}";
  adminPasswordFile = config.services.onepassword-secrets.secretPaths.couchdbAdminPassword;
in

{
  options.lab.services.couchdb = {
    enable = lib.mkEnableOption "CouchDB service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "couchdb";
      description = "Subdomain used to build the CouchDB URL";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "${toString config.lab.mounts.fast}/appdata/couchdb";
      description = "Directory where CouchDB stores databases and local config";
    };

    listenAddress = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address CouchDB listens on";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 5984;
      description = "Port CouchDB listens on";
    };

    adminUser = lib.mkOption {
      type = lib.types.str;
      default = "couchdb-admin";
      description = "CouchDB admin username";
    };

    adminPasswordReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference for CouchDB admin password";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.lab.baseDomain != "";
        message = "lab.baseDomain must be set when lab.services.couchdb.enable = true";
      }
      {
        assertion = config.services.onepassword-secrets.enable;
        message = "lab.services.couchdb.enable requires services.onepassword-secrets.enable";
      }
      {
        assertion = cfg.adminPasswordReference != "";
        message = "lab.services.couchdb.adminPasswordReference must be set";
      }
    ];

    services.onepassword-secrets.secrets.couchdbAdminPassword = {
      reference = cfg.adminPasswordReference;
      owner = "couchdb";
      group = "couchdb";
      mode = "0400";
    };

    services.couchdb = {
      enable = true;
      bindAddress = cfg.listenAddress;
      port = cfg.port;
      databaseDir = cfg.dataDir;
      viewIndexDir = cfg.dataDir;
      configFile = "${cfg.dataDir}/local.ini";
      adminPass = null;
    };

    services.caddy.virtualHosts.${serviceHost} = {
      useACMEHost = config.lab.baseDomain;
      extraConfig = ''
        reverse_proxy http://${cfg.listenAddress}:${toString cfg.port}
      '';
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 couchdb couchdb - -"
    ];

    systemd.services.couchdb = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
      preStart = lib.mkAfter ''
        admin_password="$(tr -d '\r\n' < ${adminPasswordFile})"
        : ''${admin_password:?Missing CouchDB admin password}

        if ! grep -Eq '^\[admins\]$' ${cfg.dataDir}/local.ini; then
          printf '\n[admins]\n%s = %s\n' ${cfg.adminUser} "$admin_password" >> ${cfg.dataDir}/local.ini
        elif ! grep -Eq '^${cfg.adminUser}[[:space:]]*=' ${cfg.dataDir}/local.ini; then
          printf '%s = %s\n' ${cfg.adminUser} "$admin_password" >> ${cfg.dataDir}/local.ini
        fi
      '';
    };
  };
}
