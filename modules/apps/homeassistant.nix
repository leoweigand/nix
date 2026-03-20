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
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.homeassistant.enable = true";
      }
    ];

    services.caddy.virtualHosts.${serviceHost} = {
      useACMEHost = config.homelab.baseDomain;
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

    users.groups.homeassistant = { };

    systemd.tmpfiles.rules = [
      # Parent needs group-execute so homeassistant group members can traverse to config/
      "d ${builtins.dirOf cfg.configDir} 0750 root homeassistant - -"
      # group-writable so openclaw (member of homeassistant group) can edit config files
      "d ${cfg.configDir} 0770 root homeassistant - -"
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
