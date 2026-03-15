{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.apps.immich;
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
  oidcConfigTemplate = pkgs.writeText "immich-oidc-template.json" (builtins.toJSON {
    server.externalDomain = "https://${serviceHost}";
    oauth = {
      enabled = true;
      issuerUrl = cfg.oidc.issuerUrl;
      clientId = cfg.oidc.clientId;
      clientSecret = "";
      autoRegister = cfg.oidc.autoRegister;
      scope = cfg.oidc.scope;
      buttonText = cfg.oidc.buttonText;
    };
  });
in
{
  options.homelab.apps.immich = {
    enable = lib.mkEnableOption "Immich photo and video service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "immich";
      description = "Subdomain used to build the Immich external domain";
    };

    mediaDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/photos";
      description = "Directory where Immich stores uploaded media";
    };

    oidc = {
      enable = lib.mkEnableOption "OIDC login for Immich";

      issuerUrl = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "OIDC issuer URL used by Immich";
      };

      clientId = lib.mkOption {
        type = lib.types.str;
        default = "immich";
        description = "OIDC client ID configured for Immich";
      };

      clientSecretReference = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "1Password reference for the Immich OIDC client secret";
      };

      autoRegister = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Automatically create Immich users after successful OIDC login";
      };

      scope = lib.mkOption {
        type = lib.types.str;
        default = "openid email profile";
        description = "OIDC scopes requested by Immich";
      };

      buttonText = lib.mkOption {
        type = lib.types.str;
        default = "Log in with SSO";
        description = "Login button text shown by Immich for OIDC";
      };
    };

  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.immich.enable = true";
      }
      {
        assertion = !cfg.oidc.enable || cfg.oidc.clientSecretReference != null;
        message = "homelab.apps.immich.oidc.clientSecretReference must be set when homelab.apps.immich.oidc.enable = true";
      }
      {
        assertion = !cfg.oidc.enable || cfg.oidc.issuerUrl != "";
        message = "homelab.apps.immich.oidc.issuerUrl must be set when homelab.apps.immich.oidc.enable = true";
      }
    ];

    services.onepassword-secrets.secrets = lib.optionalAttrs cfg.oidc.enable {
      immichOidcClientSecret = {
        reference = cfg.oidc.clientSecretReference;
        owner = "immich";
        group = "immich";
        mode = "0400";
      };
    };

    services.immich = {
      enable = true;

      host = "127.0.0.1";
      port = 2283;
      mediaLocation = cfg.mediaDir;
      redis = {
        host = "127.0.0.1";
        port = 6379;
      };

      settings = lib.mkIf (!cfg.oidc.enable) {
        server.externalDomain = "https://${serviceHost}";
      };
    };

    systemd.services.immich-server = lib.mkIf cfg.oidc.enable {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
      preStart = ''
        set -eu
        umask 077
        cp ${oidcConfigTemplate} /run/immich/immich.json
        secret="$(tr -d '\n' < ${config.services.onepassword-secrets.secretPaths.immichOidcClientSecret})"
        ${pkgs.jq}/bin/jq --arg secret "$secret" '.oauth.clientSecret = $secret' /run/immich/immich.json > /run/immich/immich.json.tmp
        mv /run/immich/immich.json.tmp /run/immich/immich.json
      '';
    };

    services.immich.environment = lib.mkIf cfg.oidc.enable {
      IMMICH_CONFIG_FILE = lib.mkForce "/run/immich/immich.json";
    };

    services.caddy.virtualHosts.${serviceHost} = {
      useACMEHost = config.homelab.baseDomain;
      extraConfig = ''
        reverse_proxy http://${config.services.immich.host}:${toString config.services.immich.port}
      '';
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.mediaDir} 0750 immich immich - -"
    ];

  };
}
