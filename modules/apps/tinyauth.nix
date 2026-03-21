{ config, lib, ... }:

let
  cfg = config.homelab.apps.tinyauth;
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
in

{
  options.homelab.apps.tinyauth = {
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

    # 1Password reference to an env file containing TINYAUTH_SECRET and TINYAUTH_USERS.
    # Generate user entries with:
    #   docker run -it --rm ghcr.io/steveiliop56/tinyauth:v5 user create --interactive
    envReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference to env file with TINYAUTH_SECRET and TINYAUTH_USERS";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.tinyauth.enable = true";
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
          environmentFiles = [ config.services.onepassword-secrets.secretPaths.tinyauthEnv ];
          environment = {
            TINYAUTH_APP_URL = "https://${serviceHost}";
          };
        };
      };
    };

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
