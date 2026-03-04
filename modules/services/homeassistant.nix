{ config, lib, pkgs, ... }:

let
  cfg = config.lab.services.homeassistant;
  serviceHost = "${cfg.subdomain}.${config.lab.baseDomain}";
  trustedProxiesLines = lib.concatMapStringsSep "\n" (proxy: "          printf '    - %s\\n' ${lib.escapeShellArg proxy}") cfg.trustedProxies;
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
      default = "/var/lib/homeassistant";
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
