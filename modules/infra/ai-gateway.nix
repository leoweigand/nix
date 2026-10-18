{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.infra.aiGateway;
  serviceName = "ai-gateway";
  policy = pkgs.writeText "ai-gateway-config.json" (
    builtins.toJSON {
      inherit (cfg)
        port
        chatModels
        defaultChatModel
        systemoneModels
        defaultSystemoneModel
        maxBodyBytes
        maxConcurrent
        timeoutMs
        ;
    }
  );
  launcher = pkgs.callPackage ../../packages/automation/launcher.nix { } {
    name = serviceName;
    script = "modules/infra/ai-gateway.ts";
    credentialNames = [ "api-key" ];
    environmentNames = [
      "CREDENTIALS_DIRECTORY"
      "AI_GATEWAY_CONFIG"
    ];
    bindPorts = [ cfg.port ];
  };
in
{
  options.homelab.infra.aiGateway = {
    enable = lib.mkEnableOption "private OpenCode Zen inference gateway";
    port = lib.mkOption {
      type = lib.types.port;
      default = 9088;
    };
    apiKeyReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference for the raw upstream API key";
    };
    chatModels = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "glm-5.3"
        "deepseek-v4.1-flash"
        "kimi-k3"
        "deepseek-v4-pro"
      ];
      description = "Allowed Chat Completions model IDs";
    };
    defaultChatModel = lib.mkOption {
      type = lib.types.str;
      default = "glm-5.3";
    };
    systemoneModels = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "jev-1.13" ];
    };
    defaultSystemoneModel = lib.mkOption {
      type = lib.types.str;
      default = "jev-1.13";
    };
    maxBodyBytes = lib.mkOption {
      type = lib.types.ints.positive;
      default = 16 * 1024 * 1024;
    };
    maxConcurrent = lib.mkOption {
      type = lib.types.ints.positive;
      default = 8;
    };
    timeoutMs = lib.mkOption {
      type = lib.types.ints.positive;
      default = 10 * 60 * 1000;
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.apiKeyReference != "";
        message = "AI gateway apiKeyReference must be set when enabled";
      }
      {
        assertion = config.services.onepassword-secrets.enable && config.homelab.infra.edge.enable;
        message = "AI gateway requires opnix and the edge proxy";
      }
      {
        assertion =
          builtins.elem cfg.defaultChatModel cfg.chatModels
          && builtins.elem cfg.defaultSystemoneModel cfg.systemoneModels;
        message = "AI gateway defaults must belong to their protocol allowlists";
      }
      {
        assertion = !(builtins.elem "default" (cfg.chatModels ++ cfg.systemoneModels));
        message = "AI gateway model ID default is reserved as an alias";
      }
    ];
    services.onepassword-secrets.secrets.aiGatewayApiKey = {
      reference = cfg.apiKeyReference;
      owner = "root";
      group = "root";
      mode = "0400";
      services = [ serviceName ];
    };
    homelab.infra.edge.internalProxies.ai.upstream = "http://127.0.0.1:${toString cfg.port}";
    systemd.services.${serviceName} = {
      description = "Private OpenCode Zen inference gateway";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "opnix-secrets.service"
      ];
      wants = [ "network-online.target" ];
      requires = [ "opnix-secrets.service" ];
      environment.AI_GATEWAY_CONFIG = toString policy;
      serviceConfig = {
        ExecStart = "${launcher}/bin/${serviceName}";
        LoadCredential = [ "api-key:${config.services.onepassword-secrets.secretPaths.aiGatewayApiKey}" ];
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
        UMask = "0077";
        MemoryMax = "1G";
        TasksMax = 64;
      };
    };
  };
}
