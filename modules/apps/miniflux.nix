{ config, lib, ... }:

let
  name = "miniflux";
  cfg = config.homelab.apps.${name};
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
in

{
  options.homelab.apps.${name} = {
    enable = lib.mkEnableOption "Miniflux feed reader";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "news";
      description = "Subdomain used to build the Miniflux URL";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "Local port Miniflux listens on";
    };

    adminCredentialsReference = lib.mkOption {
      type = lib.types.str;
      description = ''
        1Password reference to an env file with the bootstrap admin user:
          ADMIN_USERNAME=<username>
          ADMIN_PASSWORD=<password, length >= 6>
        Miniflux requires CREATE_ADMIN even when OIDC is enabled, so this
        account stays usable as a break-glass login.
      '';
      example = "op://Homelab/Miniflux/admin-env";
    };

    oidc = {
      enable = lib.mkEnableOption "OIDC login for Miniflux";

      issuerUrl = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "OIDC issuer URL (discovery endpoint)";
      };

      clientId = lib.mkOption {
        type = lib.types.str;
        default = "miniflux";
        description = "OIDC client ID configured at the IdP";
      };

      clientSecretReference = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          1Password reference to an env file containing:
            OAUTH2_CLIENT_SECRET=<secret>
        '';
      };

      providerName = lib.mkOption {
        type = lib.types.str;
        default = "Tinyauth";
        description = "Display name shown on the Miniflux login button";
      };

      disableLocalAuth = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Hide the username/password form so only OIDC login is offered.
          The bootstrap admin can still log in via /login?disable_local_auth=false.
        '';
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
        assertion = !cfg.oidc.enable || cfg.oidc.clientSecretReference != null;
        message = "homelab.apps.${name}.oidc.clientSecretReference must be set when oidc.enable = true";
      }
      {
        assertion = !cfg.oidc.enable || cfg.oidc.issuerUrl != "";
        message = "homelab.apps.${name}.oidc.issuerUrl must be set when oidc.enable = true";
      }
    ];

    # Miniflux runs under DynamicUser=true (no static user on the host), so the
    # EnvironmentFile is read by systemd (PID 1) before privilege drop — root
    # ownership is sufficient and avoids referencing a user that doesn't exist.
    services.onepassword-secrets.secrets = {
      minifluxAdminCredentials = {
        reference = cfg.adminCredentialsReference;
        owner = "root";
        group = "root";
        mode = "0400";
      };
    } // lib.optionalAttrs cfg.oidc.enable {
      minifluxOidcClientSecret = {
        reference = cfg.oidc.clientSecretReference;
        owner = "root";
        group = "root";
        mode = "0400";
      };
    };

    services.miniflux = {
      enable = true;
      adminCredentialsFile = config.services.onepassword-secrets.secretPaths.minifluxAdminCredentials;
      config = {
        BASE_URL = "https://${serviceHost}";
        LISTEN_ADDR = "127.0.0.1:${toString cfg.port}";
      } // lib.optionalAttrs cfg.oidc.enable {
        OAUTH2_PROVIDER = "oidc";
        OAUTH2_CLIENT_ID = cfg.oidc.clientId;
        OAUTH2_REDIRECT_URL = "https://${serviceHost}/oauth2/oidc/callback";
        OAUTH2_OIDC_DISCOVERY_ENDPOINT = cfg.oidc.issuerUrl;
        OAUTH2_OIDC_PROVIDER_NAME = cfg.oidc.providerName;
        OAUTH2_USER_CREATION = "1";
        DISABLE_LOCAL_AUTH = if cfg.oidc.disableLocalAuth then "true" else "false";
      };
    };

    # Upstream sets EnvironmentFile to adminCredentialsFile only; override with a
    # list so the OIDC client secret is also loaded into the unit's environment.
    systemd.services.miniflux = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
      serviceConfig.EnvironmentFile = lib.mkForce (
        [ config.services.onepassword-secrets.secretPaths.minifluxAdminCredentials ]
        ++ lib.optional cfg.oidc.enable config.services.onepassword-secrets.secretPaths.minifluxOidcClientSecret
      );
    };

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:${toString cfg.port}";
    };
  };
}
