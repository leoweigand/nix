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
    credentialNames = [
      "sonarr-config"
      "radarr-config"
    ];
    connectPorts = [
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
    issuer = lib.mkOption {
      type = lib.types.str;
      default = "https://auth.${config.homelab.baseDomain}";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
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
    systemd.services.leolab-mcp = {
      description = "Authenticated LeoLab MCP tools";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      unitConfig.RequiresMountsFor = [
        config.homelab.apps.sonarr.dataDir
        config.homelab.apps.radarr.dataDir
      ];
      environment = {
        MCP_CONFIG = toString policy;
      };
      serviceConfig = {
        ExecStart = "${launcher}/bin/leolab-mcp";
        LoadCredential = [
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
