{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.apps.openclaw;
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
in

{
  options.homelab.apps.openclaw = {
    enable = lib.mkEnableOption "OpenClaw gateway service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "openclaw";
      description = "Subdomain used to build the OpenClaw URL";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/appdata/openclaw/config";
      description = "Directory where OpenClaw stores config and runtime state";
    };

    workspaceDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/appdata/openclaw";
      description = "Directory mapped to OpenClaw's workspace path";
    };

    image = lib.mkOption {
      type = lib.types.str;
      default = "ghcr.io/openclaw/openclaw:2026.2.26";
      description = "Container image used for OpenClaw";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 18789;
      description = "Local host port where OpenClaw listens";
    };

    proxyAuth = {
      enable = lib.mkEnableOption "OIDC proxy auth for OpenClaw";

      clientId = lib.mkOption {
        type = lib.types.str;
        default = "openclaw";
        description = "OIDC client ID used by oauth2-proxy";
      };

      issuerUrl = lib.mkOption {
        type = lib.types.str;
        default = "https://auth.${config.homelab.baseDomain}/realms/${config.homelab.infra.auth.keycloak.realm}";
        description = "OIDC issuer URL used by oauth2-proxy";
      };

      oauth2ProxyPort = lib.mkOption {
        type = lib.types.port;
        default = 4184;
        description = "Local oauth2-proxy port for OpenClaw forward_auth";
      };

      envReference = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "1Password reference to oauth2-proxy env values for OpenClaw";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.openclaw.enable = true";
      }
      {
        assertion = !cfg.proxyAuth.enable || cfg.proxyAuth.envReference != null;
        message = "homelab.apps.openclaw.proxyAuth.envReference must be set when homelab.apps.openclaw.proxyAuth.enable = true";
      }
    ];

    services.onepassword-secrets.secrets = lib.optionalAttrs cfg.proxyAuth.enable {
      openclawOauth2ProxyEnv = {
        reference = cfg.proxyAuth.envReference;
        owner = "root";
        group = "root";
        mode = "0400";
      };
    };

    systemd.services.oauth2-proxy-openclaw = lib.mkIf cfg.proxyAuth.enable {
      description = "oauth2-proxy for OpenClaw";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "opnix-secrets.service" "podman-openclaw.service" ];
      wants = [ "network-online.target" ];
      requires = [ "opnix-secrets.service" "podman-openclaw.service" ];
      serviceConfig = {
        Type = "simple";
        Restart = "on-failure";
        RestartSec = 5;
        DynamicUser = true;
        EnvironmentFile = config.services.onepassword-secrets.secretPaths.openclawOauth2ProxyEnv;
        ExecStart = lib.concatStringsSep " " [
          "${pkgs.oauth2-proxy}/bin/oauth2-proxy"
          "--provider=oidc"
          "--reverse-proxy=true"
          "--http-address=127.0.0.1:${toString cfg.proxyAuth.oauth2ProxyPort}"
          "--oidc-issuer-url=${cfg.proxyAuth.issuerUrl}"
          "--client-id=${cfg.proxyAuth.clientId}"
          "--redirect-url=https://${serviceHost}/oauth2/callback"
          "--upstream=http://127.0.0.1:${toString cfg.port}"
          "--scope=openid profile email"
          "--email-domain=*"
          "--skip-provider-button=true"
          "--whitelist-domain=${serviceHost}"
          "--set-xauthrequest=true"
        ];
      };
    };

    services.caddy.virtualHosts.${serviceHost} = {
      useACMEHost = config.homelab.baseDomain;
      extraConfig =
        if cfg.proxyAuth.enable then
          ''
            handle /oauth2/* {
              reverse_proxy http://127.0.0.1:${toString cfg.proxyAuth.oauth2ProxyPort}
            }

            handle {
              forward_auth 127.0.0.1:${toString cfg.proxyAuth.oauth2ProxyPort} {
                uri /oauth2/auth
                header_up X-Real-IP {remote_host}
                @error status 401
                handle_response @error {
                  redir * https://${serviceHost}/oauth2/start?rd={scheme}://{host}{uri}
                }
              }

              reverse_proxy http://127.0.0.1:${toString cfg.port}
            }
          ''
        else
          ''
            reverse_proxy http://127.0.0.1:${toString cfg.port}
          '';
    };

    virtualisation = {
      podman.enable = true;
      oci-containers = {
        backend = "podman";
        containers.openclaw = {
          image = cfg.image;
          autoStart = true;
          extraOptions = [
            "--pull=newer"
          ];
          cmd = [
            "node"
            "dist/index.js"
            "gateway"
            # Keep startup non-interactive: Nix bootstraps gateway config before first run.
            "--allow-unconfigured"
            "--bind"
            "lan"
            "--port"
            "18789"
          ];
          ports = [
            "127.0.0.1:${toString cfg.port}:18789"
          ];
          volumes = [
            "${cfg.dataDir}:/home/node/.openclaw"
            "${cfg.workspaceDir}:/home/node/.openclaw/workspace"
          ];
          environment = {
            TZ = config.time.timeZone;
          };
        };
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 1000 1000 - -"
      "d ${cfg.workspaceDir} 0750 1000 1000 - -"
    ];

    systemd.services.openclaw-gateway-config = {
      description = "Prepare OpenClaw gateway configuration";
      wantedBy = [ "podman-openclaw.service" ];
      before = [ "podman-openclaw.service" ];
      path = with pkgs; [ podman ];
      serviceConfig = {
        Type = "oneshot";
        User = "root";
        Group = "root";
      };
      script = ''
        set -euo pipefail

        # OpenClaw requires explicit non-loopback settings; write them with `openclaw config set`
        # in ephemeral `podman run` calls so values persist in ${cfg.dataDir}/openclaw.json.
        podman run --rm \
          -v ${cfg.dataDir}:/home/node/.openclaw \
          -v ${cfg.workspaceDir}:/home/node/.openclaw/workspace \
          ${cfg.image} \
          node dist/index.js config set gateway.mode local

        podman run --rm \
          -v ${cfg.dataDir}:/home/node/.openclaw \
          -v ${cfg.workspaceDir}:/home/node/.openclaw/workspace \
          ${cfg.image} \
          node dist/index.js config set gateway.bind lan

        podman run --rm \
          -v ${cfg.dataDir}:/home/node/.openclaw \
          -v ${cfg.workspaceDir}:/home/node/.openclaw/workspace \
          ${cfg.image} \
          node dist/index.js config set gateway.controlUi.allowedOrigins ${lib.escapeShellArg ''["https://${serviceHost}"]''} --strict-json
      '';
    };

    systemd.services.podman-openclaw = {
      after = [ "openclaw-gateway-config.service" ];
      requires = [ "openclaw-gateway-config.service" ];
    };

  };
}
