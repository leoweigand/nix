{ config, lib, pkgs, ... }:

let
  name = "n8n";
  cfg = config.homelab.apps.${name};
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
  secretPath = config.services.onepassword-secrets.secretPaths.n8nEncryptionKey;
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
      description = "1Password reference for the n8n encryption key (raw value)";
      example = "op://Homelab/n8n/encryption-key";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.${name}.enable = true";
      }
    ];

    services.onepassword-secrets.secrets.n8nEncryptionKey = {
      reference = cfg.envReference;
      owner = "root";
      group = "root";
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
      # Allow n8n container (host networking, 127.0.0.1) to connect without a password
      authentication = lib.mkAfter ''
        host n8n n8n 127.0.0.1/32 trust
      '';
    };

    virtualisation = {
      podman.enable = true;
      oci-containers = {
        backend = "podman";
        containers.n8n = {
          image = "n8nio/n8n:${cfg.imageTag}";
          autoStart = true;
          extraOptions = [
            "--pull=newer"
            "--network=host"  # Reach host PostgreSQL on 127.0.0.1
          ];
          environmentFiles = [ "/run/n8n-env" ];
          environment = {
            N8N_HOST = serviceHost;
            N8N_PORT = "5678";
            N8N_PROTOCOL = "https";
            WEBHOOK_URL = "https://${serviceHost}";
            DB_TYPE = "postgresdb";
            DB_POSTGRESDB_HOST = "127.0.0.1";
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
      after = [ "opnix-secrets.service" "postgresql.service" ];
      requires = [ "opnix-secrets.service" "postgresql.service" ];
      # Build a KEY=VALUE env file from the raw secret value before the container starts
      serviceConfig.ExecStartPre = lib.mkBefore [
        ("+${pkgs.writeShellScript "n8n-prepare-env" ''
          printf 'N8N_ENCRYPTION_KEY=%s\n' "$(cat ${secretPath})" > /run/n8n-env
          chmod 400 /run/n8n-env
        ''}")
      ];
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 root root - -"
    ];

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:5678";
    };
  };
}
