{ config, lib, ... }:

let
  cfg = config.homelab.infra.tinyauth;
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
in

{
  options.homelab.infra.tinyauth = {
    enable = lib.mkEnableOption "TinyAuth forward-auth service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "auth";
      description = "Subdomain for the TinyAuth login UI";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3001;
      description = "Local port TinyAuth listens on";
    };

    imageTag = lib.mkOption {
      type = lib.types.str;
      default = "v5";
      description = "Container image tag for TinyAuth";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/appdata/tinyauth";
      description = "Directory for persistent TinyAuth data (OIDC keys, database)";
    };

    # 1Password reference to an env file containing TINYAUTH_AUTH_USERS and
    # TINYAUTH_OIDC_CLIENTS_<NAME>_CLIENTSECRET for any configured OIDC clients.
    # Generate user entries with (use single $ in env file, not $$):
    #   docker run -it --rm ghcr.io/steveiliop56/tinyauth:v5 user create --username <user> --password <pass>
    envReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference to env file with TINYAUTH_AUTH_USERS and OIDC client secrets";
    };

    oidcClients = lib.mkOption {
      description = "OIDC clients for which TinyAuth acts as an OIDC provider";
      default = { };
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          clientId = lib.mkOption {
            type = lib.types.str;
            description = "OIDC client ID sent by the relying party";
          };
          trustedRedirectUris = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            description = "Allowed redirect URIs for this client";
          };
        };
      });
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.infra.tinyauth.enable = true";
      }
    ];

    services.onepassword-secrets.secrets.tinyauthEnv = {
      reference = cfg.envReference;
      owner = "root";
      group = "root";
      mode = "0400";
    };

    virtualisation = {
      podman.enable = true;
      oci-containers = {
        backend = "podman";
        containers.tinyauth = {
          image = "ghcr.io/steveiliop56/tinyauth:${cfg.imageTag}";
          autoStart = true;
          extraOptions = [ "--pull=newer" ];
          ports = [ "127.0.0.1:${toString cfg.port}:3000" ];
          volumes = [ "${cfg.dataDir}:/data" ];
          environmentFiles = [ config.services.onepassword-secrets.secretPaths.tinyauthEnv ];
          environment = {
            TINYAUTH_APPURL = "https://${serviceHost}";
            TINYAUTH_DATABASE_PATH = "/data/tinyauth.db";
            # RSA keys for signing OIDC JWTs — persisted across restarts
            TINYAUTH_OIDC_PRIVATEKEYPATH = "/data/tinyauth_oidc_key";
            TINYAUTH_OIDC_PUBLICKEYPATH = "/data/tinyauth_oidc_key.pub";
          } // lib.concatMapAttrs (name: client:
            let upper = lib.toUpper name;
            in {
              "TINYAUTH_OIDC_CLIENTS_${upper}" = "true";
              "TINYAUTH_OIDC_CLIENTS_${upper}_CLIENTID" = client.clientId;
              # Comma-separated list of allowed redirect URIs
              "TINYAUTH_OIDC_CLIENTS_${upper}_TRUSTEDREDIRECTURIS" = lib.concatStringsSep "," client.trustedRedirectUris;
            }
          ) cfg.oidcClients;
        };
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 root root - -"
    ];

    systemd.services.podman-tinyauth = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    };

    services.caddy.virtualHosts.${serviceHost} = {
      useACMEHost = config.homelab.baseDomain;
      extraConfig = ''
        reverse_proxy http://127.0.0.1:${toString cfg.port}
      '';
    };
  };
}
