{ config, lib, ... }:

let
  cfg = config.homelab.infra.auth;
  domain = config.homelab.baseDomain;
  keycloakHost = "${cfg.keycloak.subdomain}.${domain}";
in

{
  options.homelab.infra.auth = {
    enable = lib.mkEnableOption "central authentication services";

    keycloak = {
      subdomain = lib.mkOption {
        type = lib.types.str;
        default = "auth";
        description = "Subdomain used for the Keycloak public URL";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 8088;
        description = "Localhost port used by Keycloak";
      };

      realm = lib.mkOption {
        type = lib.types.str;
        default = "homelab";
        description = "Realm used by OIDC clients";
      };

      dbPasswordReference = lib.mkOption {
        type = lib.types.str;
        description = "1Password reference for the Keycloak PostgreSQL user password";
      };

      database = {
        name = lib.mkOption {
          type = lib.types.str;
          default = "keycloak";
          description = "PostgreSQL database name for Keycloak";
        };

        user = lib.mkOption {
          type = lib.types.str;
          default = "keycloak";
          description = "PostgreSQL user name for Keycloak";
        };
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = domain != "";
        message = "homelab.baseDomain must be set when homelab.infra.auth.enable = true";
      }
    ];

    services.onepassword-secrets.secrets.keycloakDbPassword = {
      reference = cfg.keycloak.dbPasswordReference;
      owner = "keycloak";
      group = "keycloak";
      mode = "0400";
    };

    services.postgresql = {
      enable = true;
      ensureDatabases = [ cfg.keycloak.database.name ];
      ensureUsers = [
        {
          name = cfg.keycloak.database.user;
          ensureDBOwnership = true;
        }
      ];
    };

    services.keycloak = {
      enable = true;
      database = {
        type = "postgresql";
        createLocally = true;
        name = cfg.keycloak.database.name;
        username = cfg.keycloak.database.user;
        passwordFile = config.services.onepassword-secrets.secretPaths.keycloakDbPassword;
      };
      settings = {
        http-enabled = true;
        http-host = "127.0.0.1";
        http-port = cfg.keycloak.port;
        hostname = "https://${keycloakHost}";
        proxy-headers = "xforwarded";
      };
    };

    systemd.services.keycloak = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    };

    services.caddy.virtualHosts.${keycloakHost} = {
      useACMEHost = domain;
      extraConfig = ''
        reverse_proxy http://127.0.0.1:${toString cfg.keycloak.port}
      '';
    };
  };
}
