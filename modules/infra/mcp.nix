{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.infra.mcp;
  transferEnabled = config.homelab.apps.syncthing.enable;
  documentEnabled = cfg.documents.enable;
  bookmarkEnabled = cfg.bookmarks.enable;
  host = "mcp.${config.homelab.baseDomain}";
  launcher = pkgs.callPackage ../../packages/automation/launcher.nix { } {
    name = "leolab-mcp";
    script = "modules/infra/mcp/main.ts";
    environmentNames = [
      "MCP_CONFIG"
      "CREDENTIALS_DIRECTORY"
    ];
    credentialNames =
      lib.optional config.homelab.infra.now.enable "now-token"
      ++ lib.optional documentEnabled "paperless-token"
      ++ lib.optional bookmarkEnabled "linkding-token"
      ++ lib.optional cfg.home.enable "home-token"
      ++ lib.optional transferEnabled "syncthing-config"
      ++ [
        "sonarr-config"
        "radarr-config"
      ];
    writePaths = lib.optional documentEnabled "/var/lib/leolab-mcp";
    connectPorts =
      lib.optional config.homelab.infra.now.enable config.homelab.infra.now.port
      ++ lib.optional documentEnabled config.services.paperless.port
      ++ lib.optional bookmarkEnabled config.homelab.apps.linkding.port
      ++ lib.optional cfg.home.enable 8123
      ++ lib.optional transferEnabled 8384
      ++ [
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
      now =
        if config.homelab.infra.now.enable then
          { url = "http://127.0.0.1:${toString config.homelab.infra.now.port}"; }
        else
          null;
      documents =
        if documentEnabled then
          {
            url = "http://127.0.0.1:${toString config.services.paperless.port}";
            publicUrl = "https://${config.homelab.apps.paperless.subdomain}.${config.homelab.baseDomain}";
            stateDir = "/var/lib/leolab-mcp";
          }
        else
          null;
      bookmarks =
        if bookmarkEnabled then
          {
            url = "http://127.0.0.1:${toString config.homelab.apps.linkding.port}";
            ownerSubject = cfg.bookmarks.ownerSubject;
          }
        else
          null;
      home =
        if cfg.home.enable then
          {
            url = "http://127.0.0.1:8123";
            entities = map (entity: lib.filterAttrs (_: value: value != null) entity) cfg.home.entities;
          }
        else
          null;
      transfer =
        if transferEnabled then
          {
            url = "http://127.0.0.1:8384";
            folder = "seedhost-completed";
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
    documents = {
      enable = lib.mkEnableOption "admins-only Paperless document tools";
      tokenReference = lib.mkOption {
        type = lib.types.str;
        default = "op://Homelab/MCP Server/LEO_PAPERLESS_TOKEN";
        description = "Paperless API token, supplied only to MCP as a systemd credential";
      };
    };
    bookmarks = {
      enable = lib.mkEnableOption "owner-only Linkding bookmark tools";
      ownerSubject = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Immutable Pocket ID subject exclusively allowed to use bookmark tools";
      };
      tokenReference = lib.mkOption {
        type = lib.types.str;
        default = "op://Homelab/MCP Server/LEO_LINKDING_API_TOKEN";
        description = "Global Linkding API token, supplied only to MCP as a credential";
      };
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
        assertion = !documentEnabled || config.homelab.apps.paperless.enable;
        message = "MCP documents require Paperless";
      }

      {
        assertion =
          !bookmarkEnabled || (config.homelab.apps.linkding.enable && cfg.bookmarks.ownerSubject != "");
        message = "MCP bookmarks require Linkding and an explicit owner subject";
      }

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
      ]
      ++ lib.optional (
        config.homelab.apps.librechat.enable && config.homelab.apps.librechat.mcp.enable
      ) "10.89.10.0/24";
    };
    services.onepassword-secrets.secrets =
      lib.optionalAttrs bookmarkEnabled {
        mcpLinkdingToken = {
          reference = cfg.bookmarks.tokenReference;
          services = [ "leolab-mcp" ];
        };
      }
      // lib.optionalAttrs documentEnabled {
        mcpPaperlessToken = {
          reference = cfg.documents.tokenReference;
          services = [ "leolab-mcp" ];
        };
      }
      // lib.optionalAttrs cfg.home.enable {
        mcpHomeToken = {
          reference = cfg.home.tokenReference;
          services = [ "leolab-mcp" ];
        };
      };
    systemd.services.leolab-mcp = {
      description = "Authenticated LeoLab MCP tools";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
      ]
      ++ lib.optional (cfg.home.enable || bookmarkEnabled || documentEnabled) "opnix-secrets.service";
      wants = [ "network-online.target" ];
      requires = lib.optional (
        cfg.home.enable || bookmarkEnabled || documentEnabled
      ) "opnix-secrets.service";
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
          lib.optional documentEnabled "paperless-token:${config.services.onepassword-secrets.secretPaths.mcpPaperlessToken}"
          ++ lib.optional bookmarkEnabled "linkding-token:${config.services.onepassword-secrets.secretPaths.mcpLinkdingToken}"
          ++ lib.optional cfg.home.enable "home-token:${config.services.onepassword-secrets.secretPaths.mcpHomeToken}"
          ++ lib.optional transferEnabled "syncthing-config:${config.homelab.apps.syncthing.dataDir}/config.xml"
          ++ [
            "sonarr-config:${config.homelab.apps.sonarr.dataDir}/config.xml"
            "radarr-config:${config.homelab.apps.radarr.dataDir}/config.xml"
          ];
        StateDirectory = lib.optional documentEnabled "leolab-mcp";
        StateDirectoryMode = "0700";
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
        MemoryMax = if documentEnabled then "512M" else "256M";
        TasksMax = 64;
      };
    };
  };
}
