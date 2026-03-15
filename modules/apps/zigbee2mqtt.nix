{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.apps.zigbee2mqtt;
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
  mqttPasswordFile = config.services.onepassword-secrets.secretPaths.zigbee2mqttMqttPassword;
in

{
  options.homelab.apps.zigbee2mqtt = {
    enable = lib.mkEnableOption "Zigbee2MQTT service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "zigbee";
      description = "Subdomain used to build the Zigbee2MQTT frontend URL";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/appdata/ziqbee2mqtt/config";
      description = "Directory where Zigbee2MQTT stores configuration and state";
    };

    serialPort = lib.mkOption {
      type = lib.types.str;
      example = "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_0123456789abcdef-if00-port0";
      description = "Persistent serial device path for the Zigbee coordinator";
    };

    serialAdapter = lib.mkOption {
      type = lib.types.str;
      default = "zstack";
      description = "Zigbee2MQTT serial adapter type (Sonoff Dongle-P uses zstack, Dongle-E uses ember)";
    };

    frontendPort = lib.mkOption {
      type = lib.types.port;
      default = 8099;
      description = "Local Zigbee2MQTT frontend port";
    };

    exposeFrontend = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Expose the Zigbee2MQTT frontend through Caddy";
    };

    proxyAuth = {
      enable = lib.mkEnableOption "OIDC proxy auth for the Zigbee2MQTT frontend";

      provider = lib.mkOption {
        type = lib.types.str;
        default = "keycloak-oidc";
        description = "oauth2-proxy provider for Zigbee2MQTT auth";
      };

      clientId = lib.mkOption {
        type = lib.types.str;
        default = "zigbee2mqtt";
        description = "OIDC client ID used by oauth2-proxy";
      };

      oauth2ProxyPort = lib.mkOption {
        type = lib.types.port;
        default = 4183;
        description = "Local oauth2-proxy port for Zigbee2MQTT forward_auth";
      };

      envReference = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "1Password reference to oauth2-proxy env values for Zigbee2MQTT";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.infra.mqtt.enable;
        message = "homelab.apps.zigbee2mqtt.enable requires homelab.infra.mqtt.enable";
      }
      {
        assertion = config.homelab.baseDomain != "" || (!cfg.exposeFrontend);
        message = "homelab.baseDomain must be set when homelab.apps.zigbee2mqtt.exposeFrontend = true";
      }
      {
        assertion = !cfg.proxyAuth.enable || cfg.exposeFrontend;
        message = "homelab.apps.zigbee2mqtt.proxyAuth.enable requires homelab.apps.zigbee2mqtt.exposeFrontend = true";
      }
      {
        assertion = !cfg.proxyAuth.enable || config.homelab.infra.auth.enable;
        message = "homelab.apps.zigbee2mqtt.proxyAuth.enable requires homelab.infra.auth.enable";
      }
      {
        assertion = !cfg.proxyAuth.enable || cfg.proxyAuth.envReference != null;
        message = "homelab.apps.zigbee2mqtt.proxyAuth.envReference must be set when homelab.apps.zigbee2mqtt.proxyAuth.enable = true";
      }
    ];

    services.zigbee2mqtt = {
      enable = true;
      dataDir = cfg.dataDir;
      settings = {
        homeassistant.enabled = true;
        mqtt = {
          base_topic = "zigbee2mqtt";
          server = "mqtt://127.0.0.1:${toString config.homelab.infra.mqtt.port}";
          user = config.homelab.infra.mqtt.user;
          password = "!secret mqtt_password";  # Zigbee2MQTT reads this key from ${cfg.dataDir}/secret.yaml
        };
        serial = {
          port = cfg.serialPort;
          adapter = cfg.serialAdapter;
        };
      } // lib.optionalAttrs cfg.exposeFrontend {
        frontend = {
          enabled = true;
          host = "127.0.0.1";
          port = cfg.frontendPort;
        };
      };
    };

    services.onepassword-secrets.secrets = {
      zigbee2mqttMqttPassword = {
        reference = config.homelab.infra.mqtt.passwordReference;
        owner = "root";
        group = "root";
        mode = "0400";
      };
    } // lib.optionalAttrs cfg.proxyAuth.enable {
      zigbee2mqttOauth2ProxyEnv = {
        reference = cfg.proxyAuth.envReference;
        owner = "oauth2-proxy";
        group = "oauth2-proxy";
        mode = "0400";
      };
    };

    services.oauth2-proxy = lib.mkIf cfg.proxyAuth.enable {
      enable = true;
      keyFile = config.services.onepassword-secrets.secretPaths.zigbee2mqttOauth2ProxyEnv;
      reverseProxy = true;
      provider = cfg.proxyAuth.provider;
      oidcIssuerUrl = "https://auth.${config.homelab.baseDomain}/realms/${config.homelab.infra.auth.keycloak.realm}";
      clientID = cfg.proxyAuth.clientId;
      redirectURL = "https://${serviceHost}/oauth2/callback";
      httpAddress = "127.0.0.1:${toString cfg.proxyAuth.oauth2ProxyPort}";
      upstream = [ "http://127.0.0.1:${toString cfg.frontendPort}" ];
      scope = "openid profile email";
      email.domains = [ "*" ];
      extraConfig = {
        skip-provider-button = true;
        oidc-extra-audience = "account";
        whitelist-domain = serviceHost;
      };
    };

    services.caddy.virtualHosts.${serviceHost} = lib.mkIf cfg.exposeFrontend {
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

              reverse_proxy http://127.0.0.1:${toString cfg.frontendPort}
            }
          ''
        else
          ''
            reverse_proxy http://127.0.0.1:${toString cfg.frontendPort}
          '';
    };

    systemd.services.zigbee2mqtt-secrets = {
      description = "Prepare Zigbee2MQTT MQTT secret file";
      wantedBy = [ "zigbee2mqtt.service" ];
      before = [ "zigbee2mqtt.service" ];
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

        install -d -m 0750 -o zigbee2mqtt -g zigbee2mqtt "${cfg.dataDir}"
        install -m 0640 -o zigbee2mqtt -g zigbee2mqtt /dev/null "${cfg.dataDir}/secret.yaml"

        # opnix gives us a raw secret value; Zigbee2MQTT expects key/value YAML in secret.yaml.
        password=$(cat "${mqttPasswordFile}")
        printf 'mqtt_password: %s\n' "$password" > "${cfg.dataDir}/secret.yaml"
      '';
    };

    systemd.services.zigbee2mqtt = {
      after = [ "mosquitto.service" "zigbee2mqtt-secrets.service" ];
      requires = [ "mosquitto.service" "zigbee2mqtt-secrets.service" ];
    };

    systemd.services.oauth2-proxy = lib.mkIf cfg.proxyAuth.enable {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    };
  };
}
