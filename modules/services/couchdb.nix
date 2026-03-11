{ config, lib, pkgs, ... }:

let
  cfg = config.lab.services.couchdb;
  serviceHost = "${cfg.subdomain}.${config.lab.baseDomain}";
  credentialsFile = "${cfg.dataDir}/credentials.env";
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

  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.lab.baseDomain != "";
        message = "lab.baseDomain must be set when lab.services.couchdb.enable = true";
      }
    ];

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

    systemd.services.couchdb.preStart = lib.mkAfter ''
      if [ ! -s ${credentialsFile} ]; then
        umask 0077
        : > ${credentialsFile}
        printf 'COUCHDB_USER=%s\n' "couchdb-admin" >> ${credentialsFile}
        printf 'COUCHDB_PASSWORD=%s\n' "$(tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)" >> ${credentialsFile}
        chmod 0400 ${credentialsFile}
      fi

      source ${credentialsFile}
      : ''${COUCHDB_USER:?Missing COUCHDB_USER in ${credentialsFile}}
      : ''${COUCHDB_PASSWORD:?Missing COUCHDB_PASSWORD in ${credentialsFile}}

      if ! grep -Eq '^\[admins\]$' ${cfg.dataDir}/local.ini; then
        printf '\n[admins]\n%s = %s\n' "$COUCHDB_USER" "$COUCHDB_PASSWORD" >> ${cfg.dataDir}/local.ini
      elif ! grep -Eq "^$COUCHDB_USER[[:space:]]*=" ${cfg.dataDir}/local.ini; then
        printf '%s = %s\n' "$COUCHDB_USER" "$COUCHDB_PASSWORD" >> ${cfg.dataDir}/local.ini
      fi
    '';

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

        source ${credentialsFile}
        : ''${COUCHDB_USER:?Missing COUCHDB_USER in credentials file}
        : ''${COUCHDB_PASSWORD:?Missing COUCHDB_PASSWORD in credentials file}

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

        if ! curl -fsS -u "$COUCHDB_USER:$COUCHDB_PASSWORD" "$base_url/_up" >/dev/null; then
          node="$(curl -fsS "$base_url/_membership" | jq -r '.all_nodes[0]')"
          curl -fsS -X PUT \
            "$base_url/_node/$node/_config/admins/$COUCHDB_USER" \
            --data "$(printf '%s' "$COUCHDB_PASSWORD" | jq -Rs .)" >/dev/null
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
      '';
    };
  };
}
