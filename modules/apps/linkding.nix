{ config, lib, ... }:

let
  name = "linkding";
  cfg = config.homelab.apps.${name};
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
in

{
  options.homelab.apps.${name} = {
    enable = lib.mkEnableOption "Linkding bookmark manager";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "bookmarks";
      description = "Subdomain used to build the Linkding URL";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 9094;
      description = "Local host port used by Caddy to reach Linkding";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      description = "Directory for Linkding's SQLite database and archived bookmark assets";
    };

    imageTag = lib.mkOption {
      type = lib.types.str;
      default = "1.46.2-plus";
      description = "Container image tag for Linkding";
    };

    oidc = {
      issuerUrl = lib.mkOption {
        type = lib.types.str;
        description = "OIDC issuer URL for Linkding authentication";
      };

      clientId = lib.mkOption {
        type = lib.types.str;
        default = name;
        description = "OIDC client ID configured at the identity provider";
      };

      clientSecretReference = lib.mkOption {
        type = lib.types.str;
        description = "1Password reference to an env file containing OIDC_RP_CLIENT_SECRET";
      };

      disableLocalAuth = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Hide Linkding's local username and password login form";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.${name}.enable = true";
      }
      {
        assertion = cfg.oidc.issuerUrl != "";
        message = "homelab.apps.${name}.oidc.issuerUrl must be set";
      }
    ];

    services.onepassword-secrets.secrets.linkdingOidcEnv = {
      reference = cfg.oidc.clientSecretReference;
      owner = "root";
      group = "root";
      mode = "0400";
    };

    virtualisation = {
      podman.enable = true;
      oci-containers = {
        backend = "podman";
        containers.linkding = {
          image = "ghcr.io/sissbruecker/linkding:${cfg.imageTag}";
          autoStart = true;
          extraOptions = [ "--pull=newer" ];
          ports = [ "127.0.0.1:${toString cfg.port}:9090" ];
          volumes = [ "${cfg.dataDir}:/etc/linkding/data" ];
          environmentFiles = [ config.services.onepassword-secrets.secretPaths.linkdingOidcEnv ];
          environment = {
            TZ = config.time.timeZone;
            LD_CSRF_TRUSTED_ORIGINS = "https://${serviceHost}";
            LD_DISABLE_LOGIN_FORM = if cfg.oidc.disableLocalAuth then "True" else "False";
            LD_ENABLE_OIDC = "True";
            OIDC_OP_AUTHORIZATION_ENDPOINT = "${cfg.oidc.issuerUrl}/authorize";
            OIDC_OP_JWKS_ENDPOINT = "${cfg.oidc.issuerUrl}/.well-known/jwks.json";
            OIDC_OP_TOKEN_ENDPOINT = "${cfg.oidc.issuerUrl}/api/oidc/token";
            OIDC_OP_USER_ENDPOINT = "${cfg.oidc.issuerUrl}/api/oidc/userinfo";
            OIDC_RP_CLIENT_ID = cfg.oidc.clientId;
            OIDC_USERNAME_CLAIM = "preferred_username";
          };
        };
      };
    };

    # Linkding's bootstrap process changes the bind mount to Debian's www-data user.
    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 33 33 - -"
    ];

    systemd.services.podman-linkding = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    };

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:${toString cfg.port}";
    };
  };
}
