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
    };

    services.caddy.virtualHosts.${serviceHost} = lib.mkIf cfg.exposeFrontend {
      useACMEHost = config.homelab.baseDomain;
      extraConfig = ''
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

  };
}
