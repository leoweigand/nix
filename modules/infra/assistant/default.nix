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
  eveStateName = "leolab-assistant-eve";
  instructionsDir = "/var/lib/leolab-assistant-instructions";
  instructionBundle = pkgs.writeText "assistant-instructions.json" (
    builtins.toJSON {
      system = builtins.readFile ../../../packages/assistant/instructions/SYSTEM.md;
      channel = builtins.readFile ../../../packages/assistant/skills/telegram/SKILL.md;
      channelName = "telegram";
    }
  );
  miniAppEnabled = cfg.miniApp.enable;
  miniAppConfig = pkgs.writeText "now-telegram.json" (
    builtins.toJSON {
      issuer = config.homelab.infra.oauth2Proxy.issuerUrl;
      libraryUrl = "https://now.${config.homelab.baseDomain}/";
      loginUrl = "https://${config.homelab.infra.oauth2Proxy.subdomain}.${config.homelab.baseDomain}";
      allowedGroups = config.homelab.infra.oauth2Proxy.allowedGroups;
    }
  );
  launcher = pkgs.writeShellApplication {
    name = "leolab-assistant";
    text = ''
      exec ${sandbox}/bin/landrun \
        --rox /nix/store --ro /etc/resolv.conf --ro /etc/nsswitch.conf \
        --ro /etc/hosts --ro /dev/urandom --ro /proc/self --ro /proc/meminfo --ro /proc/cpuinfo \
        --rw ${lib.escapeShellArg cfg.stateDir} ${
          lib.optionalString (cfg.runtime == "eve") "--rw ${cfg.eveStateDir}"
        } \
        --ro ${instructionsDir} \
        --ro "$CREDENTIALS_DIRECTORY" \
        --env CREDENTIALS_DIRECTORY \
        --env ASSISTANT_INSTRUCTIONS_FILE=${instructionsDir}/current.json \
        --env SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt \
        --env HOME=${lib.escapeShellArg cfg.stateDir} \
        --env PI_CODING_AGENT_DIR=${lib.escapeShellArg "${cfg.stateDir}/agent"} \
        --env ASSISTANT_POCKET_ID_SUBJECT=${lib.escapeShellArg cfg.pocketIdSubject} \
        --env ASSISTANT_OAUTH_CALLBACK_URL=${lib.escapeShellArg "https://webhooks.${config.homelab.baseDomain}/assistant/oauth/callback"} \
        --env ASSISTANT_RUNTIME=${cfg.runtime} \
        --env ASSISTANT_NOW_ENABLED=${lib.boolToString config.homelab.infra.now.enable} \
        ${lib.optionalString (cfg.runtime == "eve") "--env ASSISTANT_EVE_STATE_DIR=${cfg.eveStateDir}"} \
        --env ASSISTANT_STATE_DIR=${lib.escapeShellArg cfg.stateDir} \
        --env TELEGRAM_WEBHOOK_SECRET --env TELEGRAM_DESTINATIONS \
        ${lib.optionalString miniAppEnabled "--env TELEGRAM_BOT_TOKEN --env ASSISTANT_MINIAPP_CONFIG=${miniAppConfig}"} \
        --env ASSISTANT_BOT_USERNAME=${lib.escapeShellArg cfg.botUsername} \
        --connect-tcp 443 --connect-tcp 9087 --bind-tcp 9090 ${
          lib.optionalString (cfg.runtime == "eve") "--connect-tcp 9091 --bind-tcp 9091"
        } \
        -- ${assistant.nodejs}/bin/node ${assistant}/lib/leolab-assistant/src/main.ts
    '';
  };
in
{
  options.homelab.infra.assistant = {
    enable = lib.mkEnableOption "Telegram assistant with user-bound LeoLab MCP tools";
    runtime = lib.mkOption {
      type = lib.types.enum [
        "pi"
        "eve"
      ];
      default = "pi";
      description = "Agent engine; Pi is the default and Eve requires an explicit rollout";
    };
    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "/mnt/fast/appdata/leolab-assistant";
      description = "Persistent inbox, conversation ledger and private OAuth credentials";
    };
    eveStateDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/${eveStateName}";
      readOnly = true;
      description = "Native-filesystem Eve runtime and workflow state; separate from the shared inbox/grants";
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
    miniApp.enable = lib.mkEnableOption "Now launcher using Telegram identity and Pocket ID browser sign-in";
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion =
          !miniAppEnabled || (config.homelab.infra.now.enable && config.homelab.infra.pocketId.enable);
        message = "The Telegram Now launcher requires Now and Pocket ID";
      }
      {
        assertion =
          config.homelab.infra.notificationGateway.enable
          && config.homelab.infra.notificationGateway.port == 9087;
        message = "The assistant requires the notification gateway on port 9087";
      }
    ];
    services.caddy.virtualHosts."${config.homelab.infra.pocketId.subdomain}.${config.homelab.baseDomain}".extraConfig =
      lib.mkIf miniAppEnabled (
        lib.mkBefore ''
          handle /now/telegram {
            reverse_proxy http://127.0.0.1:9090
          }
        ''
      );
    services.onepassword-secrets.secrets.assistantPocketIdApiKey = lib.mkIf miniAppEnabled {
      reference = "op://Homelab/Pocket ID API Key/credential";
      owner = "root";
      group = "root";
      mode = "0400";
      services = [ "leolab-assistant" ];
    };
    homelab.infra.edge.webhookRoutes = lib.mkAfter [
      {
        path = "/assistant/oauth/callback";
        rewrite = "/assistant/oauth/callback";
        upstream = "http://127.0.0.1:9090";
      }
    ];
    users.groups.leolab-assistant = { };
    services.onepassword-secrets.secrets.assistantExaApiKey = {
      reference = "op://Homelab/MCP Server/EXA_API_KEY";
      owner = "root";
      group = "root";
      mode = "0400";
      services = [ "leolab-assistant" ];
    };
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
      description = "Telegram assistant (${cfg.runtime})";
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
        LoadCredential = [
          "exa-api-key:${config.services.onepassword-secrets.secretPaths.assistantExaApiKey}"
        ]
        ++ lib.optional miniAppEnabled "pocket-id-api-key:${config.services.onepassword-secrets.secretPaths.assistantPocketIdApiKey}";
        WorkingDirectory = cfg.stateDir;
        StateDirectory = eveStateName;
        StateDirectoryMode = "0700";
        ReadWritePaths = [ cfg.stateDir ] ++ lib.optional (cfg.runtime == "eve") cfg.eveStateDir;
        Restart = "on-failure";
        RestartSec = "5s";
        TimeoutStopSec = "20s";
        MemoryMax = if cfg.runtime == "eve" then "1024M" else "768M";
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
