{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.homelab.infra.notificationGateway;
  serviceName = "notification-gateway";
  launcher = pkgs.callPackage ../../../packages/automation/launcher.nix { } {
    name = serviceName;
    script = "modules/infra/notification-gateway/notification-gateway.ts";
    bindPorts = [ cfg.port ];
    environmentNames = [
      "TELEGRAM_BOT_TOKEN"
      "TELEGRAM_DESTINATIONS"
      "TELEGRAM_WEBHOOK_SECRET"
      "TELEGRAM_WEBHOOK_URL"
      "NOTIFICATION_GATEWAY_PORT"
    ];
  };
in
{
  options.homelab.infra.notificationGateway = {
    enable = lib.mkEnableOption "private Telegram notification gateway";

    port = lib.mkOption {
      type = lib.types.port;
      default = 9087;
      description = "Local TCP port for notification submissions and the Telegram webhook";
    };

    environmentReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference for the gateway environment file";
      example = "op://Homelab/Notification Gateway/env";
    };

    webhookPath = lib.mkOption {
      type = lib.types.str;
      default = "/telegram";
      description = "Public Telegram webhook path for notification-chat discovery";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.services.onepassword-secrets.enable;
        message = "homelab.infra.notificationGateway.enable requires services.onepassword-secrets.enable";
      }
      {
        assertion = config.homelab.infra.edge.enable;
        message = "homelab.infra.notificationGateway.enable requires homelab.infra.edge.enable";
      }
      {
        assertion = cfg.environmentReference != "";
        message = "homelab.infra.notificationGateway.environmentReference must be set when the gateway is enabled";
      }
    ];

    services.onepassword-secrets.secrets.notificationGatewayEnv = {
      reference = cfg.environmentReference;
      owner = "root";
      group = "root";
      mode = "0400";
      services = [ serviceName ];
    };

    homelab.infra.edge.webhookRoutes = lib.mkAfter [
      {
        path = cfg.webhookPath;
        rewrite = "/v1/telegram-webhook";
        upstream = "http://127.0.0.1:${toString cfg.port}";
      }
    ];

    homelab.infra.edge.privateProxies.notifications = {
      upstream = "http://127.0.0.1:${toString cfg.port}";
      allowedClientRanges = [
        "127.0.0.0/8"
        "10.88.0.0/16"
        "100.64.0.0/10"
      ];
    };

    systemd.services.${serviceName} = {
      description = "Telegram notification gateway";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "opnix-secrets.service"
      ];
      wants = [ "network-online.target" ];
      requires = [ "opnix-secrets.service" ];
      serviceConfig = {
        ExecStart = "${launcher}/bin/${serviceName}";
        EnvironmentFile = config.services.onepassword-secrets.secretPaths.notificationGatewayEnv;
        Environment = [
          "NOTIFICATION_GATEWAY_PORT=${toString cfg.port}"
          "TELEGRAM_WEBHOOK_URL=https://webhooks.${config.homelab.baseDomain}${cfg.webhookPath}"
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
        UMask = "0077";
      };
    };
  };
}
