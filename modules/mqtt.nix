{ config, lib, ... }:

let
  cfg = config.lab.mqtt;
in

{
  options.lab.mqtt = {
    enable = lib.mkEnableOption "Local MQTT broker";

    port = lib.mkOption {
      type = lib.types.port;
      default = 1883;
      description = "MQTT listener port";
    };

    user = lib.mkOption {
      type = lib.types.str;
      default = "ha";
      description = "MQTT username used by Home Assistant and devices";
    };

    passwordReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference for the MQTT user password";
      example = "op://Homelab/Home Assistant/mqtt-password";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Open the MQTT port in the firewall";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.services.onepassword-secrets.enable;
        message = "lab.mqtt.enable requires services.onepassword-secrets.enable";
      }
      {
        assertion = cfg.passwordReference != "";
        message = "lab.mqtt.passwordReference must be set when lab.mqtt.enable = true";
      }
    ];

    services.onepassword-secrets.secrets.mqttBrokerPassword = {
      reference = cfg.passwordReference;
      owner = "root";
      group = "root";
      mode = "0400";
    };

    services.mosquitto = {
      enable = true;
      listeners = [
        {
          port = cfg.port;
          settings.allow_anonymous = false;
          users.${cfg.user} = {
            passwordFile = config.services.onepassword-secrets.secretPaths.mqttBrokerPassword;
            acl = [ "readwrite #" ];
          };
        }
      ];
    };

    networking.firewall.allowedTCPPorts = lib.optionals cfg.openFirewall [ cfg.port ];

    systemd.services.mosquitto = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    };
  };
}
