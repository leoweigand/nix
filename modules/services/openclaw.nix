{ config, lib, ... }:

let
  cfg = config.lab.services.openclaw;
  serviceHost = "${cfg.subdomain}.${config.lab.baseDomain}";
in

{
  options.lab.services.openclaw = {
    enable = lib.mkEnableOption "OpenClaw gateway service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "openclaw";
      description = "Subdomain used to build the OpenClaw URL";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/openclaw";
      description = "Directory where OpenClaw stores config and runtime state";
    };

    workspaceDir = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.dataDir}/workspace";
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
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.lab.baseDomain != "";
        message = "lab.baseDomain must be set when lab.services.openclaw.enable = true";
      }
    ];

    services.caddy.virtualHosts.${serviceHost} = {
      useACMEHost = config.lab.baseDomain;
      extraConfig = ''
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
      serviceConfig = {
        Type = "oneshot";
        User = "root";
        Group = "root";
      };
      script = ''
        set -euo pipefail

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
