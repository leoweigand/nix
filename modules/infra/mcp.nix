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
    environmentNames = [ "MCP_CONFIG" ];
    bindPorts = [ cfg.port ];
  };
  policy = pkgs.writeText "leolab-mcp.json" (
    builtins.toJSON {
      inherit (cfg) port;
      resource = "https://${host}/mcp";
      issuer = cfg.issuer;
      checks = [
        {
          name = "pocket-id";
          url = "${cfg.issuer}/.well-known/openid-configuration";
          expectedStatus = 200;
          issuer = cfg.issuer;
          verifies = "OIDC discovery document; does not test passkey sign-in";
        }
        {
          name = "ai-gateway";
          url = "https://ai.internal.${config.homelab.baseDomain}/healthz";
          expectedStatus = 204;
          verifies = "HTTP process health; does not invoke an upstream model";
        }
        {
          name = "notification-gateway";
          url = "https://notifications.${config.homelab.baseDomain}/healthz";
          expectedStatus = 204;
          verifies = "HTTP process health; does not test Telegram delivery";
        }
      ];
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
        assertion = config.homelab.infra.edge.enable;
        message = "LeoLab MCP requires the HTTPS edge";
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
      environment = {
        MCP_CONFIG = toString policy;
      };
      serviceConfig = {
        ExecStart = "${launcher}/bin/leolab-mcp";
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
