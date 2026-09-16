{ config, lib, ... }:

let
  name = "linkding";
  cfg = config.homelab.apps.${name};
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
      description = "Local port Linkding listens on";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      description = "Directory for bookmarks database, assets and previews";
    };

    imageTag = lib.mkOption {
      type = lib.types.str;
      default = "1.46.2-plus";
      description = "Container image tag for Linkding";
    };

    timeZone = lib.mkOption {
      type = lib.types.str;
      default = config.time.timeZone or "UTC";
      description = "Time zone used for bookmark timestamps";
    };

    oidc = {
      enable = lib.mkEnableOption "OIDC login for Linkding";

      issuerUrl = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Base URL of the OIDC provider";
      };

      clientId = lib.mkOption {
        type = lib.types.str;
        default = name;
        description = "OIDC client ID configured at the IdP";
      };

      clientSecretReference = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "1Password reference to env file with OIDC_RP_CLIENT_SECRET";
      };

      disableLoginForm = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Hide the local username/password form, leaving OIDC as the only login";
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
        assertion = !cfg.oidc.enable || cfg.oidc.issuerUrl != "";
        message = "homelab.apps.${name}.oidc.issuerUrl must be set when oidc.enable = true";
      }
      {
        assertion = !cfg.oidc.enable || cfg.oidc.clientSecretReference != null;
        message = "homelab.apps.${name}.oidc.clientSecretReference must be set when oidc.enable = true";
      }
    ];

    services.onepassword-secrets.secrets = lib.optionalAttrs cfg.oidc.enable {
      linkdingOidcEnv = {
        reference = cfg.oidc.clientSecretReference;
        owner = "root";
        group = "root";
        mode = "0400";
      };
    };

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      # No forward auth — Linkding drives the OIDC flow against TinyAuth itself,
      # and a forward_auth gate would break its callback.
      upstream = "http://127.0.0.1:${toString cfg.port}";
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
          environmentFiles = lib.optionals cfg.oidc.enable [
            config.services.onepassword-secrets.secretPaths.linkdingOidcEnv
          ];
          environment = {
            TZ = cfg.timeZone;
            # Django rejects cross-origin POSTs unless the public URL is trusted
            LD_CSRF_TRUSTED_ORIGINS = "https://${cfg.subdomain}.${config.homelab.baseDomain}";
          } // lib.optionalAttrs cfg.oidc.enable {
            LD_ENABLE_OIDC = "True";
            LD_DISABLE_LOGIN_FORM = if cfg.oidc.disableLoginForm then "True" else "False";
            OIDC_RP_CLIENT_ID = cfg.oidc.clientId;
            # TinyAuth exposes no discovery document, so each endpoint is explicit
            OIDC_OP_AUTHORIZATION_ENDPOINT = "${cfg.oidc.issuerUrl}/authorize";
            OIDC_OP_TOKEN_ENDPOINT = "${cfg.oidc.issuerUrl}/api/oidc/token";
            OIDC_OP_USER_ENDPOINT = "${cfg.oidc.issuerUrl}/api/oidc/userinfo";
            OIDC_OP_JWKS_ENDPOINT = "${cfg.oidc.issuerUrl}/.well-known/jwks.json";
            OIDC_USERNAME_CLAIM = "preferred_username";
          };
        };
      };
    };

    # 33 = www-data inside the container, which owns the bookmarks database
    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 33 33 - -"
    ];

    systemd.services.podman-linkding = lib.mkIf cfg.oidc.enable {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    };
  };
}
