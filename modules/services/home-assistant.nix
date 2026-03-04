{ config, lib, ... }:

let
  cfg = config.lab.services.homeassistant;
  serviceHost = "${cfg.subdomain}.${config.lab.baseDomain}";
in

{
  options.lab.services.homeassistant = {
    enable = lib.mkEnableOption "Home Assistant service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "home";
      description = "Subdomain used to build the Home Assistant URL";
    };

    configDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/home-assistant";
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
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.lab.baseDomain != "";
        message = "lab.baseDomain must be set when lab.services.homeassistant.enable = true";
      }
    ];

    services.caddy.virtualHosts.${serviceHost} = {
      useACMEHost = config.lab.baseDomain;
      extraConfig = ''
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
          ];
          ports = [
            "127.0.0.1:8123:8123"
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
  };
}
