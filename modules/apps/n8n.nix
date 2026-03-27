{ config, lib, pkgs, ... }:

let
  name = "n8n";
  cfg = config.homelab.apps.${name};
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
  secretPath = config.services.onepassword-secrets.secretPaths.n8nEnv;
in

{
  options.homelab.apps.${name} = {
    enable = lib.mkEnableOption "n8n workflow automation service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = name;
      description = "Subdomain used to build the n8n URL";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/mnt/fast/appdata/n8n";
      description = "Directory for n8n runtime data (config, logs)";
    };

    imageTag = lib.mkOption {
      type = lib.types.str;
      default = "latest";
      description = "Container image tag for n8n";
    };

    envReference = lib.mkOption {
      type = lib.types.str;
      description = ''
        1Password reference to a KEY=VALUE env file with:
          N8N_ENCRYPTION_KEY=<32-char random string>
          DB_POSTGRESDB_PASSWORD=<database password>
      '';
      example = "op://Homelab/n8n/env-file";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.${name}.enable = true";
      }
    ];

    services.onepassword-secrets.secrets.n8nEnv = {
      reference = cfg.envReference;
      # postgres needs to read this to set the DB password; root bypasses permissions anyway
      owner = "postgres";
      group = "postgres";
      mode = "0400";
    };

    # NixOS requires manual PostgreSQL configuration
    services.postgresql = {
      enable = true;
      ensureDatabases = [ "n8n" ];
      ensureUsers = [{
        name = "n8n";
        ensureDBOwnership = true;
      }];
      # Allow n8n container to authenticate over TCP; podman uses the 10.88.0.0/16 bridge network
      authentication = lib.mkAfter ''
        host n8n n8n 10.88.0.0/16 scram-sha-256
      '';
    };

    # Set the PostgreSQL n8n user password from the env file before the container starts.
    # Runs on every boot so the password stays in sync with the secret.
    systemd.services.n8n-db-password = {
      description = "Set PostgreSQL password for n8n";
      after = [ "postgresql.service" "opnix-secrets.service" ];
      requires = [ "postgresql.service" "opnix-secrets.service" ];
      wantedBy = [ "podman-n8n.service" ];
      before = [ "podman-n8n.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "postgres";
        ExecStart = pkgs.writeShellScript "n8n-set-db-password" ''
          password=$(${pkgs.gnugrep}/bin/grep '^DB_POSTGRESDB_PASSWORD=' ${secretPath} | ${pkgs.coreutils}/bin/cut -d= -f2-)
          # :'pass' quotes the variable as a SQL string literal; pipe via stdin because
          # psql variable interpolation does not apply when using the -c flag
          echo "ALTER USER n8n WITH PASSWORD :'pass'" \
            | ${config.services.postgresql.package}/bin/psql -v "pass=$password"
        '';
      };
    };

    virtualisation = {
      podman.enable = true;
      oci-containers = {
        backend = "podman";
        containers.n8n = {
          image = "n8nio/n8n:${cfg.imageTag}";
          autoStart = true;
          extraOptions = [ "--pull=newer" ];
          ports = [ "127.0.0.1:5678:5678" ];
          environmentFiles = [ secretPath ];
          environment = {
            N8N_HOST = serviceHost;
            N8N_PORT = "5678";
            N8N_PROTOCOL = "https";
            WEBHOOK_URL = "https://${serviceHost}";
            # host.containers.internal resolves to the host gateway in podman's bridge network
            DB_TYPE = "postgresdb";
            DB_POSTGRESDB_HOST = "host.containers.internal";
            DB_POSTGRESDB_PORT = "5432";
            DB_POSTGRESDB_DATABASE = "n8n";
            DB_POSTGRESDB_USER = "n8n";
            GENERIC_TIMEZONE = "Europe/Berlin";
            N8N_DIAGNOSTICS_ENABLED = "false";
            N8N_VERSION_NOTIFICATIONS_ENABLED = "false";
          };
          volumes = [ "${cfg.dataDir}:/home/node/.n8n" ];
        };
      };
    };

    systemd.services."podman-n8n" = {
      after = [ "opnix-secrets.service" "postgresql.service" "n8n-db-password.service" ];
      requires = [ "opnix-secrets.service" "n8n-db-password.service" ];
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 root root - -"
    ];

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:5678";
    };
  };
}
