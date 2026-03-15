{ config, lib, pkgs, ... }:

let
  cfg = config.homelab.apps.assistant;
  baseDir = "${config.homelab.mounts.fast}/assistant";
  srcDir = "${baseDir}/src";
  workspaceDir = "${baseDir}/workspace";
  stateDir = "${baseDir}/state";
  allowedChatIds = lib.concatMapStringsSep "," toString cfg.telegram.allowedChats;
in
{
  options.homelab.apps.assistant = {
    enable = lib.mkEnableOption "minimal Telegram assistant bot";

    telegram = {
      tokenReference = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "1Password reference for the Telegram bot token";
      };

      allowedChats = lib.mkOption {
        type = lib.types.listOf lib.types.int;
        default = [ ];
        description = "Allowed Telegram chat IDs (users/groups)";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.telegram.tokenReference != "";
        message = "homelab.apps.assistant.telegram.tokenReference must be set when homelab.apps.assistant.enable = true";
      }
      {
        assertion = cfg.telegram.allowedChats != [ ];
        message = "homelab.apps.assistant.telegram.allowedChats must contain at least one chat ID when homelab.apps.assistant.enable = true";
      }
    ];

    users.groups.assistant = { };

    users.users.assistant = {
      isSystemUser = true;
      group = "assistant";
      home = baseDir;
      createHome = false;
      shell = "/run/current-system/sw/bin/nologin";
    };

    services.onepassword-secrets.secrets.assistantTelegramToken = {
      reference = cfg.telegram.tokenReference;
      owner = "assistant";
      group = "assistant";
      mode = "0400";
    };

    systemd.tmpfiles.rules = [
      "d ${baseDir} 0750 assistant assistant - -"
      "d ${srcDir} 0750 assistant assistant - -"
      "d ${workspaceDir} 0750 assistant assistant - -"
      "d ${stateDir} 0750 assistant assistant - -"
      "d ${baseDir}/logs 0750 assistant assistant - -"
    ];

    systemd.services.assistant-telegram = {
      description = "Picard assistant Telegram bot";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" "opnix-secrets.service" ];
      wants = [ "network-online.target" ];
      requires = [ "opnix-secrets.service" ];
      path = with pkgs; [ deno ];
      serviceConfig = {
        Type = "simple";
        User = "assistant";
        Group = "assistant";
        WorkingDirectory = srcDir;
        Environment = [
          "TELEGRAM_TOKEN_FILE=${config.services.onepassword-secrets.secretPaths.assistantTelegramToken}"
          "ALLOWED_CHAT_IDS=${allowedChatIds}"
          "STATE_DIR=${stateDir}"
          "WORKSPACE_DIR=${workspaceDir}"
        ];
        ExecStart = lib.concatStringsSep " " [
          "${pkgs.deno}/bin/deno"
          "run"
          "--allow-env"
          "--allow-net"
          "--allow-read"
          "--allow-write"
          "${srcDir}/index.ts"
        ];
        Restart = "on-failure";
        RestartSec = 5;
      };
    };
  };
}
