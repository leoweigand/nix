{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.infra.authentik;
  domain = config.homelab.baseDomain;
  serviceHost = "${cfg.subdomain}.${domain}";
  postgresPasswordFile = config.services.onepassword-secrets.secretPaths.authentikPostgresPassword;
  secretKeyFile = config.services.onepassword-secrets.secretPaths.authentikSecretKey;
  bootstrapPasswordFile = lib.optionalString (cfg.bootstrapPasswordReference != null)
    config.services.onepassword-secrets.secretPaths.authentikBootstrapPassword;
in

{
  options.homelab.infra.authentik = {
    enable = lib.mkEnableOption "Authentik identity provider";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "authentik";
      description = "Subdomain used for the Authentik public URL";
    };

    image = lib.mkOption {
      type = lib.types.str;
      default = "ghcr.io/goauthentik/server:latest";
      description = "Container image used for Authentik server and worker";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 9000;
      description = "Localhost port used by the Authentik server HTTP listener";
    };

    mediaDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/appdata/authentik/media";
      description = "Persistent media directory mounted into Authentik containers";
    };

    templatesDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/appdata/authentik/templates";
      description = "Directory for optional custom Authentik templates";
    };

    postgresDataDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/appdata/authentik/postgres";
      description = "Persistent data directory for the Authentik PostgreSQL container";
    };

    redisDataDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/appdata/authentik/redis";
      description = "Persistent data directory for the Authentik Redis container";
    };

    postgresPasswordReference = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "1Password reference for Authentik PostgreSQL password";
    };

    secretKeyReference = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "1Password reference for AUTHENTIK_SECRET_KEY";
    };

    bootstrapPasswordReference = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Optional 1Password reference for one-time Authentik bootstrap admin password";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = domain != "";
        message = "homelab.baseDomain must be set when homelab.infra.authentik.enable = true";
      }
      {
        assertion = cfg.postgresPasswordReference != null;
        message = "homelab.infra.authentik.postgresPasswordReference must be set when Authentik is enabled";
      }
      {
        assertion = cfg.secretKeyReference != null;
        message = "homelab.infra.authentik.secretKeyReference must be set when Authentik is enabled";
      }
    ];

    services.onepassword-secrets.secrets = {
      authentikPostgresPassword = {
        reference = cfg.postgresPasswordReference;
        owner = "root";
        group = "root";
        mode = "0400";
      };

      authentikSecretKey = {
        reference = cfg.secretKeyReference;
        owner = "root";
        group = "root";
        mode = "0400";
      };
    } // lib.optionalAttrs (cfg.bootstrapPasswordReference != null) {
      authentikBootstrapPassword = {
        reference = cfg.bootstrapPasswordReference;
        owner = "root";
        group = "root";
        mode = "0400";
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.mediaDir} 0750 root root - -"
      "d ${cfg.templatesDir} 0750 root root - -"
      "d ${cfg.postgresDataDir} 0700 root root - -"
      "d ${cfg.redisDataDir} 0750 root root - -"
      "d /run/authentik 0750 root root - -"
    ];

    systemd.services.authentik-env = {
      description = "Prepare Authentik container environment files";
      wantedBy = [
        "podman-authentik-postgresql.service"
        "podman-authentik-redis.service"
        "podman-authentik-server.service"
        "podman-authentik-worker.service"
      ];
      before = [
        "podman-authentik-postgresql.service"
        "podman-authentik-redis.service"
        "podman-authentik-server.service"
        "podman-authentik-worker.service"
      ];
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
      path = with pkgs; [ coreutils ];
      serviceConfig = {
        Type = "oneshot";
        User = "root";
        Group = "root";
      };
      script = ''
        set -euo pipefail

        install -d -m 0750 -o root -g root /run/authentik

        pg_password=$(cat ${postgresPasswordFile})
        secret_key=$(cat ${secretKeyFile})

        install -m 0400 -o root -g root /dev/null /run/authentik/postgres.env
        {
          printf 'POSTGRES_DB=authentik\n'
          printf 'POSTGRES_USER=authentik\n'
          printf 'POSTGRES_PASSWORD=%s\n' "$pg_password"
        } > /run/authentik/postgres.env

        install -m 0400 -o root -g root /dev/null /run/authentik/authentik.env
        {
          printf 'AUTHENTIK_SECRET_KEY=%s\n' "$secret_key"
          printf 'AUTHENTIK_REDIS__HOST=127.0.0.1\n'
          printf 'AUTHENTIK_REDIS__PORT=6379\n'
          printf 'AUTHENTIK_POSTGRESQL__HOST=127.0.0.1\n'
          printf 'AUTHENTIK_POSTGRESQL__PORT=5432\n'
          printf 'AUTHENTIK_POSTGRESQL__NAME=authentik\n'
          printf 'AUTHENTIK_POSTGRESQL__USER=authentik\n'
          printf 'AUTHENTIK_POSTGRESQL__PASSWORD=%s\n' "$pg_password"
          printf 'AUTHENTIK_DISABLE_STARTUP_ANALYTICS=true\n'
          printf 'AUTHENTIK_ERROR_REPORTING__ENABLED=false\n'
          printf 'AUTHENTIK_LISTEN__HTTP=0.0.0.0:9000\n'
          printf 'AUTHENTIK_LISTEN__HTTPS=\n'
        } > /run/authentik/authentik.env

        ${lib.optionalString (cfg.bootstrapPasswordReference != null) ''
          bootstrap_password=$(cat ${bootstrapPasswordFile})
          printf 'AUTHENTIK_BOOTSTRAP_PASSWORD=%s\n' "$bootstrap_password" >> /run/authentik/authentik.env
        ''}
      '';
    };

    systemd.services.authentik-pod = {
      description = "Create Authentik Podman pod";
      wantedBy = [
        "podman-authentik-postgresql.service"
        "podman-authentik-redis.service"
        "podman-authentik-server.service"
        "podman-authentik-worker.service"
      ];
      before = [
        "podman-authentik-postgresql.service"
        "podman-authentik-redis.service"
        "podman-authentik-server.service"
        "podman-authentik-worker.service"
      ];
      path = with pkgs; [ podman ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        set -euo pipefail
        if ! podman pod exists authentik; then
          podman pod create --name authentik --publish 127.0.0.1:${toString cfg.port}:9000
        fi
      '';
      postStop = ''
        ${pkgs.podman}/bin/podman pod rm -f authentik >/dev/null 2>&1 || true
      '';
    };

    virtualisation = {
      podman.enable = true;
      oci-containers = {
        backend = "podman";
        containers = {
          authentik-postgresql = {
            image = "docker.io/library/postgres:16-alpine";
            autoStart = true;
            environmentFiles = [ "/run/authentik/postgres.env" ];
            extraOptions = [ "--pod=authentik" "--pull=newer" ];
            volumes = [
              "${cfg.postgresDataDir}:/var/lib/postgresql/data"
            ];
          };

          authentik-redis = {
            image = "docker.io/library/redis:7-alpine";
            autoStart = true;
            cmd = [ "redis-server" "--save" "60" "1" "--loglevel" "warning" ];
            extraOptions = [ "--pod=authentik" "--pull=newer" ];
            volumes = [
              "${cfg.redisDataDir}:/data"
            ];
          };

          authentik-server = {
            image = cfg.image;
            autoStart = true;
            cmd = [ "server" ];
            environmentFiles = [ "/run/authentik/authentik.env" ];
            extraOptions = [ "--pod=authentik" "--pull=newer" ];
            volumes = [
              "${cfg.mediaDir}:/media"
              "${cfg.templatesDir}:/templates"
            ];
          };

          authentik-worker = {
            image = cfg.image;
            autoStart = true;
            cmd = [ "worker" ];
            environmentFiles = [ "/run/authentik/authentik.env" ];
            extraOptions = [ "--pod=authentik" "--pull=newer" ];
            volumes = [
              "${cfg.mediaDir}:/media"
              "${cfg.templatesDir}:/templates"
              "/var/run/podman/podman.sock:/var/run/docker.sock"
            ];
          };
        };
      };
    };

    systemd.services.podman-authentik-postgresql = {
      after = [ "authentik-env.service" "authentik-pod.service" ];
      requires = [ "authentik-env.service" "authentik-pod.service" ];
    };

    systemd.services.podman-authentik-redis = {
      after = [ "authentik-pod.service" ];
      requires = [ "authentik-pod.service" ];
    };

    systemd.services.podman-authentik-server = {
      after = [
        "podman-authentik-postgresql.service"
        "podman-authentik-redis.service"
        "authentik-env.service"
        "authentik-pod.service"
      ];
      requires = [
        "podman-authentik-postgresql.service"
        "podman-authentik-redis.service"
        "authentik-env.service"
        "authentik-pod.service"
      ];
    };

    systemd.services.podman-authentik-worker = {
      after = [
        "podman-authentik-postgresql.service"
        "podman-authentik-redis.service"
        "authentik-env.service"
        "authentik-pod.service"
      ];
      requires = [
        "podman-authentik-postgresql.service"
        "podman-authentik-redis.service"
        "authentik-env.service"
        "authentik-pod.service"
      ];
    };

    services.caddy.virtualHosts.${serviceHost} = {
      useACMEHost = domain;
      extraConfig = ''
        reverse_proxy http://127.0.0.1:${toString cfg.port}
      '';
    };
  };
}
