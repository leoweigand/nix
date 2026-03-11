{ config, lib, pkgs, ... }:

let
  cfg = config.lab.services.couchdb;
  serviceHost = "${cfg.subdomain}.${config.lab.baseDomain}";
  adminPasswordFile = config.services.onepassword-secrets.secretPaths.couchdbAdminPassword;
  syncPasswordFile = config.services.onepassword-secrets.secretPaths.couchdbSyncPassword;
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

    bootstrap = {
      database = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Optional application database to initialize";
      };

      username = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Optional application user to initialize";
      };

      passwordReference = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "1Password reference for optional application user password";
      };
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
      {
        assertion =
          (cfg.bootstrap.database == null && cfg.bootstrap.username == null && cfg.bootstrap.passwordReference == null)
          || (cfg.bootstrap.database != null && cfg.bootstrap.username != null && cfg.bootstrap.passwordReference != null);
        message = "Set bootstrap.database, bootstrap.username, and bootstrap.passwordReference together (or leave all null)";
      }
    ];

    services.onepassword-secrets.secrets = {
      couchdbAdminPassword = {
        reference = cfg.adminPasswordReference;
        owner = "root";
        group = "root";
        mode = "0400";
        services = [ "couchdb.service" "couchdb-init.service" ];
      };
    } // lib.optionalAttrs (cfg.bootstrap.passwordReference != null) {
      couchdbSyncPassword = {
        reference = cfg.bootstrap.passwordReference;
        owner = "root";
        group = "root";
        mode = "0400";
        services = [ "couchdb-init.service" ];
      };
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

    systemd.services.couchdb-init = {
      description = "Initialize CouchDB auth and CORS settings";
      wantedBy = [ "multi-user.target" ];
      after = [ "couchdb.service" ];
      requires = [ "couchdb.service" ];
      path = with pkgs; [ curl coreutils jq ];
      serviceConfig = {
        Type = "oneshot";
        User = "root";
        Group = "root";
      };
      script = ''
        set -euo pipefail

        COUCHDB_USER='${cfg.adminUser}'
        COUCHDB_PASSWORD="$(tr -d '\r\n' < ${adminPasswordFile})"
        : ''${COUCHDB_PASSWORD:?Missing admin password}

        ${lib.optionalString (cfg.bootstrap.passwordReference != null) ''
          SYNC_USER='${cfg.bootstrap.username}'
          SYNC_PASSWORD="$(tr -d '\r\n' < ${syncPasswordFile})"
          : ''${SYNC_PASSWORD:?Missing sync user password}
        ''}

        base_url="http://${cfg.listenAddress}:${toString cfg.port}"

        for _ in $(seq 1 30); do
          if curl -fsS "$base_url/_up" >/dev/null; then
            break
          fi
          sleep 1
        done

        if ! curl -fsS "$base_url/_up" >/dev/null; then
          echo "CouchDB did not become ready in time"
          exit 1
        fi

        node="$(curl -fsS -u "$COUCHDB_USER:$COUCHDB_PASSWORD" "$base_url/_membership" | jq -r '.all_nodes[0]')"

        set_cfg() {
          local section="$1"
          local key="$2"
          local value="$3"
          curl -fsS -u "$COUCHDB_USER:$COUCHDB_PASSWORD" -X PUT \
            "$base_url/_node/$node/_config/$section/$key" \
            --data "$(printf '%s' "$value" | jq -Rs .)" >/dev/null
        }

        set_cfg chttpd enable_cors true
        set_cfg cors credentials true
        set_cfg cors methods "GET, PUT, POST, HEAD, DELETE"
        set_cfg cors headers "accept, authorization, content-type, origin, referer"
        set_cfg cors origins "app://obsidian.md,capacitor://localhost,http://localhost"

        ${lib.optionalString (cfg.bootstrap.database != null) ''
          put_db() {
            local db="$1"
            local status
            status="$(curl -sS -o /dev/null -w "%{http_code}" -u "$COUCHDB_USER:$COUCHDB_PASSWORD" -X PUT "$base_url/$db")"
            [ "$status" = "201" ] || [ "$status" = "202" ] || [ "$status" = "412" ]
          }

          put_db "_users"
          put_db "${cfg.bootstrap.database}"

          user_doc="$base_url/_users/org.couchdb.user:$SYNC_USER"
          existing_user="$(curl -fsS -u "$COUCHDB_USER:$COUCHDB_PASSWORD" "$user_doc" || true)"
          user_rev=""
          if [ -n "$existing_user" ]; then
            user_rev="$(printf '%s' "$existing_user" | jq -r '._rev // empty')"
          fi

          user_payload="$(jq -n --arg name "$SYNC_USER" --arg pass "$SYNC_PASSWORD" --arg rev "$user_rev" '
            {
              _id: ("org.couchdb.user:" + $name),
              name: $name,
              password: $pass,
              roles: [],
              type: "user"
            }
            + (if $rev == "" then {} else { _rev: $rev } end)
          ')"

          curl -fsS -u "$COUCHDB_USER:$COUCHDB_PASSWORD" -X PUT "$user_doc" \
            -H 'Content-Type: application/json' \
            --data "$user_payload" >/dev/null

          security_payload="$(jq -n --arg name "$SYNC_USER" '{ admins: { names: [], roles: [] }, members: { names: [ $name ], roles: [] } }')"

          curl -fsS -u "$COUCHDB_USER:$COUCHDB_PASSWORD" -X PUT "$base_url/${cfg.bootstrap.database}/_security" \
            -H 'Content-Type: application/json' \
            --data "$security_payload" >/dev/null
        ''}
      '';
    };
  };
}
