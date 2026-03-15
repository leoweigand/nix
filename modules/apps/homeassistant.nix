{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.apps.homeassistant;
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
  trustedProxiesLines = lib.concatMapStringsSep "\n" (proxy: "          printf '    - %s\\n' ${lib.escapeShellArg proxy}") cfg.trustedProxies;
in

{
  options.homelab.apps.homeassistant = {
    enable = lib.mkEnableOption "Home Assistant service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "home";
      description = "Subdomain used to build the Home Assistant URL";
    };

    configDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/appdata/homeassistant/config";
      description = "Directory where Home Assistant stores configuration and state";
    };

    imageTag = lib.mkOption {
      type = lib.types.str;
      default = "stable";
      description = "Container image tag for Home Assistant";
    };

    extraVolumes = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Additional bind mounts for integrations (for example USB serial devices)";
    };

    trustedProxies = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "10.88.0.0/16" ];
      description = "Trusted reverse proxy CIDRs for Home Assistant's HTTP integration";
    };

    proxyAuth = {
      enable = lib.mkEnableOption "OIDC proxy auth for Home Assistant";

      clientId = lib.mkOption {
        type = lib.types.str;
        default = "homeassistant";
        description = "OIDC client ID used by oauth2-proxy";
      };

      issuerUrl = lib.mkOption {
        type = lib.types.str;
        default = "https://auth.${config.homelab.baseDomain}/realms/${config.homelab.infra.auth.keycloak.realm}";
        description = "OIDC issuer URL used by oauth2-proxy";
      };

      oauth2ProxyPort = lib.mkOption {
        type = lib.types.port;
        default = 4185;
        description = "Local oauth2-proxy port for Home Assistant forward_auth";
      };

      envReference = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "1Password reference to oauth2-proxy env values for Home Assistant";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.homeassistant.enable = true";
      }
      {
        assertion = !cfg.proxyAuth.enable || cfg.proxyAuth.envReference != null;
        message = "homelab.apps.homeassistant.proxyAuth.envReference must be set when homelab.apps.homeassistant.proxyAuth.enable = true";
      }
    ];

    services.onepassword-secrets.secrets = lib.optionalAttrs cfg.proxyAuth.enable {
      homeassistantOauth2ProxyEnv = {
        reference = cfg.proxyAuth.envReference;
        owner = "root";
        group = "root";
        mode = "0400";
      };
    };

    systemd.services.oauth2-proxy-homeassistant = lib.mkIf cfg.proxyAuth.enable {
      description = "oauth2-proxy for Home Assistant";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "opnix-secrets.service" "podman-homeassistant.service" ];
      wants = [ "network-online.target" ];
      requires = [ "opnix-secrets.service" "podman-homeassistant.service" ];
      serviceConfig = {
        Type = "simple";
        Restart = "on-failure";
        RestartSec = 5;
        DynamicUser = true;
        EnvironmentFile = config.services.onepassword-secrets.secretPaths.homeassistantOauth2ProxyEnv;
        ExecStart = lib.concatStringsSep " " [
          "${pkgs.oauth2-proxy}/bin/oauth2-proxy"
          "--provider=oidc"
          "--reverse-proxy=true"
          "--http-address=127.0.0.1:${toString cfg.proxyAuth.oauth2ProxyPort}"
          "--oidc-issuer-url=${cfg.proxyAuth.issuerUrl}"
          "--client-id=${cfg.proxyAuth.clientId}"
          "--redirect-url=https://${serviceHost}/oauth2/callback"
          "--upstream=http://127.0.0.1:8123"
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

              reverse_proxy http://127.0.0.1:8123
            }
          ''
        else
          ''
            reverse_proxy http://127.0.0.1:8123
          '';
    };

    virtualisation = {
      podman.enable = true;
      oci-containers = {
        backend = "podman";
        containers.homeassistant = {
          image = "homeassistant/home-assistant:${cfg.imageTag}";
          autoStart = true;
          extraOptions = [
            "--pull=newer"
            "--network=host"  # Required for reliable mDNS/HomeKit discovery from LAN clients
            # DHCP watcher logs a warning without NET_RAW, but current setup does not rely on DHCP discovery.
          ];
          volumes = [
            "${cfg.configDir}:/config"
          ] ++ cfg.extraVolumes;
          environment = {
            TZ = config.time.timeZone;
          };
        };
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.configDir} 0750 root root - -"
    ];

    systemd.services.homeassistant-proxy-config = {
      description = "Prepare Home Assistant reverse proxy settings";
      wantedBy = [ "podman-homeassistant.service" ];
      before = [ "podman-homeassistant.service" ];
      path = with pkgs; [ coreutils gnugrep ];
      serviceConfig = {
        Type = "oneshot";
        User = "root";
        Group = "root";
      };
      script = ''
        set -euo pipefail

        config_file="${cfg.configDir}/configuration.yaml"
        touch "$config_file"

        if ! grep -Eq '^http:[[:space:]]*$' "$config_file"; then
          {
            printf '\nhttp:\n'
            printf '  use_x_forwarded_for: true\n'
            printf '  trusted_proxies:\n'
${trustedProxiesLines}
          } >> "$config_file"
        fi
      '';
    };

    systemd.services.podman-homeassistant = {
      after = [ "homeassistant-proxy-config.service" ];
      requires = [ "homeassistant-proxy-config.service" ];
    };
  };
}
