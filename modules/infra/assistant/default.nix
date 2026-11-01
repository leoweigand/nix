{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.infra.assistant;
  assistant = pkgs.callPackage ../../../packages/assistant { };
  sandbox = pkgs.callPackage ../../../packages/automation/sandbox.nix { };
  instructionsDir = "/var/lib/leolab-assistant-instructions";
  instructionBundle = pkgs.writeText "assistant-instructions.json" (
    builtins.toJSON {
      system = builtins.readFile ../../../packages/assistant/instructions/SYSTEM.md;
      channel = builtins.readFile ../../../packages/assistant/skills/telegram/SKILL.md;
      channelName = "telegram";
    }
  );
  launcher = pkgs.writeShellApplication {
    name = "leolab-assistant";
    text = ''
      exec ${sandbox}/bin/landrun \
        --rox /nix/store --ro /etc/resolv.conf --ro /etc/nsswitch.conf \
        --ro /etc/hosts --ro /dev/urandom --ro /proc/self --ro /proc/meminfo --ro /proc/cpuinfo \
        --rw ${lib.escapeShellArg cfg.stateDir} \
        --ro ${instructionsDir} \
        --env ASSISTANT_INSTRUCTIONS_FILE=${instructionsDir}/current.json \
        --env SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt \
        --env HOME=${lib.escapeShellArg cfg.stateDir} \
        --env PI_CODING_AGENT_DIR=${lib.escapeShellArg "${cfg.stateDir}/agent"} \
        --env ASSISTANT_POCKET_ID_SUBJECT=${lib.escapeShellArg cfg.pocketIdSubject} \
        --env ASSISTANT_OAUTH_CALLBACK_URL=${lib.escapeShellArg "https://webhooks.${config.homelab.baseDomain}/assistant/oauth/callback"} \
        --env ASSISTANT_STATE_DIR=${lib.escapeShellArg cfg.stateDir} \
        --env TELEGRAM_WEBHOOK_SECRET --env TELEGRAM_DESTINATIONS \
        --env ASSISTANT_BOT_USERNAME=${lib.escapeShellArg cfg.botUsername} \
        --connect-tcp 443 --connect-tcp 9087 --bind-tcp 9090 \
        -- ${assistant.nodejs}/bin/node ${assistant}/lib/leolab-assistant/src/main.ts
    '';
  };
in
{
  options.homelab.infra.assistant = {
    enable = lib.mkEnableOption "Pi Telegram assistant with user-bound LeoLab MCP tools";
    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "/mnt/fast/appdata/leolab-assistant";
      description = "Persistent inbox, Pi sessions and private OAuth credentials";
    };
    pocketIdSubject = lib.mkOption {
      type = lib.types.str;
      description = "Immutable Pocket ID subject allowed to connect the owner Telegram account";
    };
    botUsername = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Telegram bot username, without @; empty disables group replies";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion =
          config.homelab.infra.notificationGateway.enable
          && config.homelab.infra.notificationGateway.port == 9087;
        message = "The assistant requires the notification gateway on port 9087";
      }
    ];
    homelab.infra.edge.webhookRoutes = lib.mkAfter [
      {
        path = "/assistant/oauth/callback";
        rewrite = "/assistant/oauth/callback";
        upstream = "http://127.0.0.1:9090";
      }
    ];
    users.groups.leolab-assistant = { };
    users.users.leolab-assistant = {
      isSystemUser = true;
      group = "leolab-assistant";
    };
    systemd.tmpfiles.rules = [
      "d ${cfg.stateDir} 0700 leolab-assistant leolab-assistant - -"
      "d ${instructionsDir} 0750 root leolab-assistant - -"
      "C ${instructionsDir}/current.json 0640 root leolab-assistant - ${instructionBundle}"
    ];
    systemd.services.leolab-assistant = {
      description = "Pi Telegram assistant";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "notification-gateway.service"
        "leolab-mcp.service"
        "opnix-secrets.service"
      ];
      wants = [ "network-online.target" ];
      requires = [ "opnix-secrets.service" ];
      unitConfig.RequiresMountsFor = cfg.stateDir;
      serviceConfig = {
        ExecStart = "${launcher}/bin/leolab-assistant";
        User = "leolab-assistant";
        Group = "leolab-assistant";
        EnvironmentFile = config.services.onepassword-secrets.secretPaths.notificationGatewayEnv;
        WorkingDirectory = cfg.stateDir;
        ReadWritePaths = [ cfg.stateDir ];
        Restart = "on-failure";
        RestartSec = "5s";
        TimeoutStopSec = "20s";
        MemoryMax = "768M";
        TasksMax = 64;
        UMask = "0077";
        NoNewPrivileges = true;
        PrivateDevices = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        SystemCallArchitectures = "native";
      };
    };
  };
}
