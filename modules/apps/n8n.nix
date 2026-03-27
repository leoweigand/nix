{ config, lib, ... }:

let
  name = "n8n";
  cfg = config.homelab.apps.${name};
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
in

{
  options.homelab.apps.${name} = {
    enable = lib.mkEnableOption "n8n workflow automation service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = name;
      description = "Subdomain used to build the n8n URL";
    };

    envReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference to an env file containing N8N_ENCRYPTION_KEY";
      example = "op://Homelab/n8n/envFile";
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
    };

    services.n8n = {
      enable = true;
      environment = {
        N8N_HOST = serviceHost;
        N8N_PROTOCOL = "https";
        WEBHOOK_URL = "https://${serviceHost}";
        # DynamicUser names the process user "n8n", matching the PostgreSQL role,
        # so peer auth works over the Unix socket without a password.
        DB_TYPE = "postgresdb";
        DB_POSTGRESDB_HOST = "/run/postgresql";
        DB_POSTGRESDB_DATABASE = "n8n";
        DB_POSTGRESDB_USER = "n8n";
        GENERIC_TIMEZONE = "Europe/Berlin";
        N8N_DIAGNOSTICS_ENABLED = "false";
        N8N_VERSION_NOTIFICATIONS_ENABLED = "false";
      };
    };

    # systemd reads EnvironmentFile as root before privilege drop, so root-owned mode 0400 is fine
    systemd.services.n8n = {
      after = [ "opnix-secrets.service" "postgresql.service" ];
      requires = [ "opnix-secrets.service" ];
      serviceConfig.EnvironmentFile = config.services.onepassword-secrets.secretPaths.n8nEnv;
    };

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:5678";
    };
  };
}
