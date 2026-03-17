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
      default = "${config.homelab.mounts.fast}/appdata/openclaw";
      description = "Directory where OpenClaw stores config and runtime state";
    };

    workspaceDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/appdata/openclaw/workspace";
      description = "Workspace directory for the default/main OpenClaw agent";
    };

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.openclaw;
      description = "OpenClaw package to run as a native systemd service";
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
        default = "";
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
    nixpkgs.config.permittedInsecurePackages = [
      "${cfg.package.pname}-${cfg.package.version}"
    ];

    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.openclaw.enable = true";
      }
      {
        assertion = !cfg.proxyAuth.enable || cfg.proxyAuth.envReference != null;
        message = "homelab.apps.openclaw.proxyAuth.envReference must be set when homelab.apps.openclaw.proxyAuth.enable = true";
      }
      {
        assertion = !cfg.proxyAuth.enable || cfg.proxyAuth.issuerUrl != "";
        message = "homelab.apps.openclaw.proxyAuth.issuerUrl must be set when homelab.apps.openclaw.proxyAuth.enable = true";
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
      after = [ "network-online.target" "opnix-secrets.service" "openclaw.service" ];
      wants = [ "network-online.target" ];
      requires = [ "opnix-secrets.service" "openclaw.service" ];
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

    users.groups.openclaw = { };

    users.users.openclaw = {
      isSystemUser = true;
      group = "openclaw";
      home = cfg.dataDir;
      createHome = false;
      shell = "/run/current-system/sw/bin/nologin";
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0750 openclaw openclaw - -"
      "d ${cfg.workspaceDir} 0750 openclaw openclaw - -"
    ];

    environment.shellAliases = {
      openclaw = "sudo -u openclaw OPENCLAW_STATE_DIR=${cfg.dataDir} OPENCLAW_CONFIG_PATH=${cfg.dataDir}/openclaw.json ${lib.getExe cfg.package}";
    };

    systemd.services.openclaw = {
      description = "OpenClaw gateway";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" "openclaw-data-permissions.service" "openclaw-gateway-config.service" ];
      requires = [ "openclaw-data-permissions.service" "openclaw-gateway-config.service" ];
      serviceConfig = {
        Type = "simple";
        User = "openclaw";
        Group = "openclaw";
        WorkingDirectory = cfg.workspaceDir;
        Environment = [
          "OPENCLAW_STATE_DIR=${cfg.dataDir}"
          "OPENCLAW_CONFIG_PATH=${cfg.dataDir}/openclaw.json"
          "TZ=${config.time.timeZone}"
        ];
        ExecStart = lib.concatStringsSep " " [
          (lib.getExe cfg.package)
          "gateway"
          "--allow-unconfigured"
          "--bind"
          "lan"
          "--port"
          (toString cfg.port)
        ];
        Restart = "on-failure";
        RestartSec = 5;
      };
    };

    systemd.services.openclaw-data-permissions = {
      description = "Normalize OpenClaw state and workspace ownership";
      wantedBy = [ "openclaw.service" ];
      before = [ "openclaw.service" ];
      serviceConfig = {
        Type = "oneshot";
        User = "root";
        Group = "root";
      };
      script = ''
        set -euo pipefail

        # Keep migrated files readable by the dedicated service account.
        chown -R openclaw:openclaw ${cfg.dataDir}
      '';
    };

    systemd.services.openclaw-gateway-config = {
      description = "Prepare OpenClaw gateway configuration";
      wantedBy = [ "openclaw.service" ];
      before = [ "openclaw.service" ];
      path = with pkgs; [ jq coreutils ];
      serviceConfig = {
        Type = "oneshot";
        User = "openclaw";
        Group = "openclaw";
        TimeoutStartSec = 60;
        Environment = [
          "OPENCLAW_STATE_DIR=${cfg.dataDir}"
          "OPENCLAW_CONFIG_PATH=${cfg.dataDir}/openclaw.json"
        ];
      };
      script = ''
        set -euo pipefail

        config_file="${cfg.dataDir}/openclaw.json"
        tmp_file=$(mktemp)

        if [ -f "$config_file" ]; then
          jq --arg workspace ${lib.escapeShellArg cfg.workspaceDir} --arg origin ${lib.escapeShellArg "https://${serviceHost}"} '
            .gateway = ((.gateway // {}) + { mode: "local", bind: "lan" })
            | .gateway.controlUi = ((.gateway.controlUi // {}) + { allowedOrigins: [ $origin ] })
            | .agents = (.agents // {})
            | .agents.defaults = ((.agents.defaults // {}) + { workspace: $workspace })
          ' "$config_file" > "$tmp_file"
        else
          jq -n --arg workspace ${lib.escapeShellArg cfg.workspaceDir} --arg origin ${lib.escapeShellArg "https://${serviceHost}"} '
            {
              gateway: {
                mode: "local",
                bind: "lan",
                controlUi: {
                  allowedOrigins: [ $origin ]
                }
              },
              agents: {
                defaults: {
                  workspace: $workspace
                }
              }
            }
          ' > "$tmp_file"
        fi

        mv "$tmp_file" "$config_file"
      '';
    };

  };
}
