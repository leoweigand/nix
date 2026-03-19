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
    ];

    services.caddy.virtualHosts.${serviceHost} = {
      useACMEHost = config.homelab.baseDomain;
      extraConfig = ''
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
