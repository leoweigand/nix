{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.homelab.apps.open-webui;
  mcp = config.homelab.infra.mcp;
  mcpUrl = "https://mcp.${config.homelab.baseDomain}/mcp";
  mcpScopes = "openid groups offline_access lab:read media:read media:request home:read home:control bookmarks:read bookmarks:write documents:read documents:ingest now:read now:write";
  mcpConnections = pkgs.writeText "open-webui-mcp.json" (
    builtins.toJSON [
      {
        type = "mcp";
        url = mcpUrl;
        path = "";
        auth_type = "oauth_2.1";
        key = "";
        config = {
          enable = true;
          access_grants = [
            {
              principal_type = "user";
              principal_id = "*";
              permission = "read";
            }
          ];
        };
        info = {
          id = "leolab";
          name = "LeoLab";
          description = "Lab media, home devices, bookmarks, documents and Now apps";
          oauth_scope = mcpScopes;
          oauth_client_info = {
            client_id = "leolab-mcp-open-webui";
            client_name = "LeoLab MCP — Open WebUI";
            token_endpoint_auth_method = "none";
            redirect_uris = [
              "https://${cfg.subdomain}.${config.homelab.baseDomain}/oauth/clients/mcp:leolab/callback"
            ];
            grant_types = [
              "authorization_code"
              "refresh_token"
            ];
            response_types = [ "code" ];
            scope = mcpScopes;
            resource = mcpUrl;
            issuer = "${mcp.issuer}/.well-known/openid-configuration";
            server_metadata = {
              issuer = mcp.issuer;
              authorization_endpoint = "${mcp.issuer}/authorize";
              token_endpoint = "${mcp.issuer}/api/oidc/token";
              response_types_supported = [ "code" ];
              code_challenge_methods_supported = [ "S256" ];
              token_endpoint_auth_methods_supported = [ "none" ];
            };
          };
        };
      }
    ]
  );
in
{
  options.homelab.apps.open-webui = {
    enable = lib.mkEnableOption "Open WebUI chat interface";
    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "chat";
      description = "Subdomain for Open WebUI";
    };
    image = lib.mkOption {
      type = lib.types.str;
      default = "ghcr.io/open-webui/open-webui:v0.13.0-slim@sha256:9c583de5686ed3f92e992a9326a99225e951047176ccc5644fcd4352b77eb959";
      description = "Release and amd64 digest of the lightweight API-only image";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 3006;
      description = "Loopback port for Open WebUI";
    };
    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/open-webui";
      description = "Local filesystem state; keep SQLite off virtiofs";
    };
    extraModels = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Additional gateway chat model IDs exposed in the model selector";
    };
    mcp.enable = lib.mkEnableOption "the shared LeoLab MCP connection with per-user Pocket ID consent";
    backupDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Prepared state directory within the appdata backup tree";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = !cfg.mcp.enable || mcp.enable;
        message = "Open WebUI's LeoLab connection requires the MCP service";
      }
      {
        assertion = config.homelab.infra.aiGateway.enable;
        message = "Open WebUI requires the homelab AI gateway";
      }
      {
        assertion = lib.hasPrefix "/" cfg.dataDir && cfg.dataDir != "/";
        message = "Open WebUI dataDir must be an absolute directory other than /";
      }
      {
        assertion =
          cfg.backupDir == null
          || (
            lib.hasPrefix "/" cfg.backupDir
            && cfg.backupDir != "/"
            && cfg.backupDir != cfg.dataDir
            && !(lib.hasPrefix "${cfg.dataDir}/" cfg.backupDir)
            && !(lib.hasPrefix "${cfg.backupDir}/" cfg.dataDir)
          );
        message = "Open WebUI backupDir must be an absolute directory outside dataDir";
      }
    ];

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:${toString cfg.port}";
      auth = {
        passUser = true;
        passEmail = true;
      };
    };

    virtualisation.podman.enable = true;
    virtualisation.oci-containers = {
      backend = "podman";
      containers.open-webui = {
        image = cfg.image;
        ports = [ "127.0.0.1:${toString cfg.port}:8080" ];
        volumes = [
          "${cfg.dataDir}:/app/backend/data"
        ]
        ++ lib.optionals cfg.mcp.enable [
          "${./open-webui/mcp.py}:/run/open-webui/mcp.py:ro"
          "${mcpConnections}:/run/open-webui/mcp.json:ro"
        ];
        cmd = lib.optionals cfg.mcp.enable [
          "python"
          "/run/open-webui/mcp.py"
          "/run/open-webui/mcp.json"
        ];
        environment = {
          WEBUI_URL = "https://${cfg.subdomain}.${config.homelab.baseDomain}";
          CORS_ALLOW_ORIGIN = "https://${cfg.subdomain}.${config.homelab.baseDomain}";
          WEBUI_AUTH_TRUSTED_EMAIL_HEADER = "Remote-Email";
          WEBUI_AUTH_TRUSTED_NAME_HEADER = "Remote-User";
          ENABLE_SIGNUP = "False";
          ENABLE_LOGIN_FORM = "False";
          # Trusted-header sign-in shares this endpoint; the header is mandatory.
          ENABLE_PASSWORD_AUTH = "True";
          DEFAULT_USER_ROLE = "user";
          WEBUI_AUTH_COOKIE_SECURE = "True";
          # Persist the generated signing key alongside the database and uploads.
          WEBUI_SECRET_KEY_FILE = "/app/backend/data/.webui_secret_key";
          ENABLE_PERSISTENT_CONFIG = "False";
          ENABLE_TOOL_SERVERS = "True";
          ENABLE_OLLAMA_API = "False";
          OPENAI_API_BASE_URLS = "https://inference.internal.${config.homelab.baseDomain}/v1";
          OPENAI_API_KEYS = "unused";
          # Jev has a separate API and Beam's free tier rejects third-party clients.
          OPENAI_API_CONFIGS = builtins.toJSON {
            "0" = {
              enable = true;
              model_ids = lib.unique (
                (lib.filter (model: model != "beam-free") config.homelab.infra.aiGateway.chatModels)
                ++ cfg.extraModels
              );
            };
          };
          DEFAULT_MODELS = config.homelab.infra.aiGateway.defaultChatModel;
          # Hosted chat needs neither local embedding models nor speech downloads.
          OFFLINE_MODE = "True";
          HF_HUB_OFFLINE = "1";
          ENABLE_VERSION_UPDATE_CHECK = "False";
          DO_NOT_TRACK = "True";
          SCARF_NO_ANALYTICS = "True";
          ANONYMIZED_TELEMETRY = "False";
        };
        extraOptions = [
          "--memory=1536m"
          "--cpus=2"
        ];
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0700 root root - -"
    ]
    ++ lib.optional (cfg.backupDir != null) "d ${cfg.backupDir} 0700 root root - -";
    systemd.services.podman-open-webui.unitConfig.RequiresMountsFor = [ cfg.dataDir ];

    systemd.services.open-webui-backup = lib.mkIf (cfg.backupDir != null) {
      description = "Prepare Open WebUI state for restic with writes quiesced";
      unitConfig.RequiresMountsFor = [
        cfg.dataDir
        cfg.backupDir
      ];
      serviceConfig.Type = "oneshot";
      path = [
        pkgs.systemd
        pkgs.rsync
        pkgs.sqlite
      ];
      script = ''
        set -euo pipefail
        umask 077
        was_active=false
        if systemctl is-active --quiet podman-open-webui.service; then
          was_active=true
          trap 'if "$was_active"; then systemctl start podman-open-webui.service; fi' EXIT
          systemctl stop podman-open-webui.service
        fi
        test -s ${lib.escapeShellArg "${cfg.dataDir}/webui.db"}
        rsync -a --delete --chmod=D700,F600 --chown=root:root ${lib.escapeShellArg "${cfg.dataDir}/"} ${lib.escapeShellArg "${cfg.backupDir}/"}
        test "$(sqlite3 ${lib.escapeShellArg "${cfg.backupDir}/webui.db"} 'PRAGMA quick_check;')" = ok
      '';
    };
    homelab.infra.backup.jobs.appdata.prepareCommand =
      lib.mkIf (cfg.backupDir != null && config.homelab.infra.backup.enable)
        (
          lib.mkAfter ''
            ${pkgs.systemd}/bin/systemctl start open-webui-backup.service
          ''
        );
  };
}
