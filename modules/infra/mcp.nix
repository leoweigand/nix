{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.infra.mcp;
  host = "mcp.${config.homelab.baseDomain}";
  launcher = pkgs.callPackage ../../packages/automation/launcher.nix { } {
    name = "leolab-mcp";
    script = "modules/infra/mcp/main.ts";
    environmentNames = [
      "MCP_CONFIG"
      "CREDENTIALS_DIRECTORY"
    ];
    credentialNames = lib.optional cfg.home.enable "home-token" ++ [
      "sonarr-config"
      "radarr-config"
    ];
    connectPorts = lib.optional cfg.home.enable 8123 ++ [
      443
      8989
      7878
    ];
    bindPorts = [ cfg.port ];
  };
  policy = pkgs.writeText "leolab-mcp.json" (
    builtins.toJSON {
      inherit (cfg) port;
      resource = "https://${host}/mcp";
      issuer = cfg.issuer;
      home =
        if cfg.home.enable then
          {
            url = "http://127.0.0.1:8123";
            entities = map (entity: lib.filterAttrs (_: value: value != null) entity) cfg.home.entities;
          }
        else
          null;
      media = {
        sonarr = {
          url = "http://127.0.0.1:8989";
          rootFolder = "/media/library/tv";
        };
        radarr = {
          url = "http://127.0.0.1:7878";
          rootFolder = "/media/library/films";
        };
      };
    }
  );
in
{
  options.homelab.infra.mcp = {
    enable = lib.mkEnableOption "authenticated LeoLab MCP tools";
    port = lib.mkOption {
      type = lib.types.port;
      default = 9089;
    };
    home = {
      enable = lib.mkEnableOption "Home Assistant device tools";
      tokenReference = lib.mkOption {
        type = lib.types.str;
        default = "op://Homelab/MCP Server/HA_TOKEN";
      };
      entities = lib.mkOption {
        type = lib.types.listOf (
          lib.types.submodule {
            options = {
              entityId = lib.mkOption { type = lib.types.str; };
              name = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
              };
              room = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
              };
              aliases = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
              };
              actions = lib.mkOption {
                type = lib.types.listOf (
                  lib.types.enum [
                    "turn_on"
                    "turn_off"
                    "set_brightness"
                    "open"
                    "close"
                    "stop"
                    "set_position"
                  ]
                );
                default = [ ];
              };
            };
          }
        );
        default = [ ];
        description = "Explicit readable entities and their permitted controls";
      };
    };
    issuer = lib.mkOption {
      type = lib.types.str;
      default = "https://auth.${config.homelab.baseDomain}";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.home.enable || config.homelab.apps.homeassistant.enable;
        message = "MCP home tools require Home Assistant";
      }
      {
        assertion =
          config.homelab.infra.edge.enable
          && config.homelab.apps.sonarr.enable
          && config.homelab.apps.radarr.enable;
        message = "LeoLab MCP requires the HTTPS edge, Sonarr and Radarr";
      }
    ];
    homelab.infra.edge.privateProxies.mcp = {
      upstream = "http://127.0.0.1:${toString cfg.port}";
      allowedClientRanges = [
        "127.0.0.0/8"
        "192.168.2.0/24"
        "100.64.0.0/10"
      ];
    };
    services.onepassword-secrets.secrets = lib.mkIf cfg.home.enable {
      mcpHomeToken = {
        reference = cfg.home.tokenReference;
        services = [ "leolab-mcp" ];
      };
    };
    systemd.services.leolab-mcp = {
      description = "Authenticated LeoLab MCP tools";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ] ++ lib.optional cfg.home.enable "opnix-secrets.service";
      wants = [ "network-online.target" ];
      requires = lib.optional cfg.home.enable "opnix-secrets.service";
      unitConfig.RequiresMountsFor = [
        config.homelab.apps.sonarr.dataDir
        config.homelab.apps.radarr.dataDir
      ];
      environment = {
        MCP_CONFIG = toString policy;
      };
      serviceConfig = {
        ExecStart = "${launcher}/bin/leolab-mcp";
        LoadCredential =
          lib.optional cfg.home.enable "home-token:${config.services.onepassword-secrets.secretPaths.mcpHomeToken}"
          ++ [
            "sonarr-config:${config.homelab.apps.sonarr.dataDir}/config.xml"
            "radarr-config:${config.homelab.apps.radarr.dataDir}/config.xml"
          ];
        DynamicUser = true;
        Restart = "on-failure";
        RestartSec = "5s";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectClock = true;
        ProtectControlGroups = true;
        ProtectHome = true;
        ProtectHostname = true;
        ProtectKernelLogs = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        ProtectSystem = "strict";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
        CapabilityBoundingSet = "";
        UMask = "0077";
        MemoryMax = "256M";
        TasksMax = 64;
      };
    };
  };
}
