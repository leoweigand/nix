{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.apps.librechat;
  domain = config.homelab.baseDomain;
  url = "https://${cfg.subdomain}.${domain}";
  settings = pkgs.writeText "librechat.yaml" (
    builtins.toJSON (
      {
        version = "1.3.18";
        cache = true;
        registration.socialLogins = [ "openid" ];
        endpoints.custom = [
          {
            name = "LeoLab";
            apiKey = "unused";
            baseURL = "https://inference.internal.${domain}/v1";
            models = {
              default = lib.unique (
                (lib.filter (m: m != "beam-free") config.homelab.infra.aiGateway.chatModels) ++ cfg.extraModels
              );
              fetch = false;
            };
            titleConvo = true;
            titleModel = config.homelab.infra.aiGateway.defaultChatModel;
            modelDisplayLabel = "LeoLab";
          }
        ];
      }
      // lib.optionalAttrs cfg.mcp.enable {
        mcpSettings.allowedAddresses = [
          "mcp.${domain}:443"
          "auth.${domain}:443"
        ];
        mcpServers.leolab = {
          type = "streamable-http";
          url = "https://mcp.${domain}/mcp";
          title = "LeoLab";
          requiresOAuth = true;
          startup = false;
          serverInstructions = true;
          oauth = {
            client_id = "leolab-mcp-librechat";
            authorization_url = "${config.homelab.infra.mcp.issuer}/authorize";
            token_url = "${config.homelab.infra.mcp.issuer}/api/oidc/token";
            redirect_uri = "${url}/api/mcp/leolab/oauth/callback";
            scope = "openid groups offline_access lab:read media:read media:request home:read home:control bookmarks:read bookmarks:write documents:read documents:ingest now:read now:write";
            token_endpoint_auth_methods_supported = [ "none" ];
            code_challenge_methods_supported = [ "S256" ];
          };
        };
      }
    )
  );
in
{
  options.homelab.apps.librechat = {
    enable = lib.mkEnableOption "LibreChat";
    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "chat";
    };
    image = lib.mkOption {
      type = lib.types.str;
      default = "registry.librechat.ai/librechat-ai/librechat-dev@sha256:b8b073ff1f62b122401b5f882f9ef8bd8b78ae156a29b646b2dabe227b6f9e47";
    };
    mongoImage = lib.mkOption {
      type = lib.types.str;
      default = "docker.io/library/mongo:8.0.20@sha256:972a9fa5d0f06418faa85d3f831ebba14e203a55dee5cd2dbcaf09490d2eff31";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 3006;
    };
    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/librechat";
    };
    backupDir = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
    };
    extraModels = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
    };
    mcp.enable = lib.mkEnableOption "per-user LeoLab MCP access";
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.infra.aiGateway.enable;
        message = "LibreChat requires the AI gateway";
      }
      {
        assertion = !cfg.mcp.enable || config.homelab.infra.mcp.enable;
        message = "LibreChat requires the MCP service";
      }
      {
        assertion = lib.hasPrefix "/" cfg.dataDir && cfg.dataDir != "/";
        message = "LibreChat dataDir must be absolute and not /";
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
        message = "LibreChat backupDir must be absolute and outside dataDir";
      }
    ];
    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:${toString cfg.port}";
      auth = false;
    };
    homelab.infra.edge.internalAllowedClientRanges = lib.mkAfter [ "10.89.10.0/24" ];
    virtualisation.podman.enable = true;
    systemd.tmpfiles.rules = [
      "d ${cfg.dataDir} 0711 root root - -"
      "d ${cfg.dataDir}/mongo 0700 999 999 - -"
      "d ${cfg.dataDir}/uploads 0700 1000 1000 - -"
      "d ${cfg.dataDir}/images 0755 1000 1000 - -"
      "d ${cfg.dataDir}/logs 0700 1000 1000 - -"
      "d ${cfg.dataDir}/data 0700 1000 1000 - -"
    ]
    ++ lib.optional (cfg.backupDir != null) "d ${cfg.backupDir} 0700 root root - -";
    systemd.services.librechat-prepare = {
      description = "Prepare LibreChat network and persistent encryption keys";
      before = [
        "podman-librechat.service"
        "podman-librechat-mongo.service"
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        UMask = "0077";
      };
      unitConfig.RequiresMountsFor = [ cfg.dataDir ];
      path = [
        pkgs.podman
        pkgs.openssl
        pkgs.coreutils
      ];
      script = ''
        podman network exists librechat || podman network create --subnet 10.89.10.0/24 librechat
        # Generated once on the host: no secrets in the Nix store or vault writes.
        if ! test -s ${lib.escapeShellArg "${cfg.dataDir}/secrets.env"}; then
          tmp=$(mktemp ${lib.escapeShellArg "${cfg.dataDir}/secrets.env.XXXXXX"})
          for key in CREDS_KEY JWT_SECRET JWT_REFRESH_SECRET OPENID_SESSION_SECRET; do
            printf '%s=%s\n' "$key" "$(openssl rand -hex 32)" >> "$tmp"
          done
          printf 'CREDS_IV=%s\n' "$(openssl rand -hex 16)" >> "$tmp"
          mv "$tmp" ${lib.escapeShellArg "${cfg.dataDir}/secrets.env"}
        fi
      '';
    };
    virtualisation.oci-containers = {
      backend = "podman";
      containers.librechat-mongo = {
        image = cfg.mongoImage;
        volumes = [ "${cfg.dataDir}/mongo:/data/db" ];
        cmd = [
          "mongod"
          "--noauth"
          "--wiredTigerCacheSizeGB"
          "0.25"
        ];
        extraOptions = [
          "--network=librechat"
          "--network-alias=mongodb"
          "--memory=768m"
          "--cpus=1"
        ];
      };
      containers.librechat = {
        image = cfg.image;
        user = "1000:1000";
        dependsOn = [ "librechat-mongo" ];
        ports = [ "127.0.0.1:${toString cfg.port}:3080" ];
        environmentFiles = [ "${cfg.dataDir}/secrets.env" ];
        volumes = [
          "${settings}:/app/librechat.yaml:ro"
          "${cfg.dataDir}/uploads:/app/uploads"
          "${cfg.dataDir}/images:/app/client/public/images"
          "${cfg.dataDir}/logs:/app/logs"
          "${cfg.dataDir}/data:/app/data"
        ];
        environment = {
          HOST = "0.0.0.0";
          PORT = "3080";
          DOMAIN_CLIENT = url;
          DOMAIN_SERVER = url;
          TRUST_PROXY = "1";
          MONGO_URI = "mongodb://mongodb:27017/LibreChat";
          ENDPOINTS = "custom";
          SEARCH = "false";
          SCHEDULES_SINGLE_PROCESS = "true";
          ALLOW_EMAIL_LOGIN = "false";
          ALLOW_REGISTRATION = "false";
          ALLOW_SOCIAL_LOGIN = "true";
          ALLOW_SOCIAL_REGISTRATION = "true";
          ALLOW_PASSWORD_RESET = "false";
          OPENID_CLIENT_ID = "leolab-librechat";
          OPENID_CLIENT_SECRET = "";
          OPENID_ISSUER = config.homelab.infra.mcp.issuer;
          OPENID_SCOPE = "openid profile email groups";
          OPENID_CALLBACK_URL = "/oauth/openid/callback";
          OPENID_USE_PKCE = "true";
          OPENID_REQUIRED_ROLE = "admins";
          OPENID_REQUIRED_ROLE_TOKEN_KIND = "id";
          OPENID_REQUIRED_ROLE_PARAMETER_PATH = "groups";
          OPENID_ADMIN_ROLE = "admins";
          OPENID_ADMIN_ROLE_TOKEN_KIND = "id";
          OPENID_ADMIN_ROLE_PARAMETER_PATH = "groups";
          OPENID_BUTTON_LABEL = "Pocket ID";
          OPENID_AUTO_REDIRECT = "true";
          ALLOW_SHARED_LINKS_PUBLIC = "false";
          LIBRECHAT_TEMP_CREDENTIALS_PATH = "/app/data/.env.temp";
        };
        extraOptions = [
          "--network=librechat"
          "--memory=1536m"
          "--cpus=2"
        ];
      };
    };
    systemd.services.podman-librechat = {
      requires = [ "librechat-prepare.service" ];
      after = [ "librechat-prepare.service" ];
      unitConfig.RequiresMountsFor = [ cfg.dataDir ];
    };
    systemd.services.podman-librechat-mongo = {
      requires = [ "librechat-prepare.service" ];
      after = [ "librechat-prepare.service" ];
      unitConfig.RequiresMountsFor = [ cfg.dataDir ];
    };
    systemd.services.librechat-backup = lib.mkIf (cfg.backupDir != null) {
      description = "Prepare quiesced LibreChat database, uploads and keys for restic";
      unitConfig.RequiresMountsFor = [
        cfg.dataDir
        cfg.backupDir
      ];
      serviceConfig.Type = "oneshot";
      path = [
        pkgs.systemd
        pkgs.rsync
      ];
      script = ''
        set -euo pipefail
        umask 077
        api_active=false
        mongo_active=false
        restart_services() {
          if "$mongo_active"; then systemctl start podman-librechat-mongo.service; fi
          if "$api_active"; then systemctl start podman-librechat.service; fi
        }
        trap restart_services EXIT
        if systemctl is-active --quiet podman-librechat.service; then
          api_active=true
          systemctl stop podman-librechat.service
        fi
        if systemctl is-active --quiet podman-librechat-mongo.service; then
          mongo_active=true
          systemctl stop podman-librechat-mongo.service
        fi
        test -s ${lib.escapeShellArg "${cfg.dataDir}/mongo/WiredTiger"}
        test -s ${lib.escapeShellArg "${cfg.dataDir}/secrets.env"}
        rsync -a --delete --exclude=logs --chmod=D700,F600 ${lib.escapeShellArg "${cfg.dataDir}/"} ${lib.escapeShellArg "${cfg.backupDir}/"}
      '';
    };
    homelab.infra.backup.jobs.appdata.prepareCommand =
      lib.mkIf (cfg.backupDir != null && config.homelab.infra.backup.enable)
        (
          lib.mkAfter ''
            ${pkgs.systemd}/bin/systemctl start librechat-backup.service
          ''
        );
  };
}
