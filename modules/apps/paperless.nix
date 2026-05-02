{ config, lib, pkgs, ... }:

let
  name = "paperless";
  cfg = config.homelab.apps.${name};
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";

  llmTitleScript = pkgs.writers.writePython3Bin "paperless-llm-title" {
    flakeIgnore = [ "E501" "E731" "W503" ];
  } (builtins.readFile ./paperless-llm-title.py);

  llmEnabled = cfg.llmTitleExtraction.enable;

  llmEnv = {
    PAPERLESS_LLM_API_USERNAME = "admin";
    PAPERLESS_LLM_API_PASSWORD_FILE = config.services.onepassword-secrets.secretPaths.paperlessAdminPassword;
    PAPERLESS_LLM_OPENAI_KEY_FILE = config.services.onepassword-secrets.secretPaths.paperlessOpenaiKey;
    PAPERLESS_LLM_MODEL = cfg.llmTitleExtraction.model;
  };
in

{
  options.homelab.apps.${name} = {
    enable = lib.mkEnableOption "Paperless-ngx service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = name;
      description = "Subdomain used to build the Paperless URL";
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/paperless";
      description = "Directory where Paperless stores internal application state";
    };

    mediaDir = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.dataDir}/media";
      description = "Directory where Paperless stores processed documents";
    };

    consumptionDir = lib.mkOption {
      type = lib.types.str;
      default = "${cfg.dataDir}/consume";
      description = "Directory Paperless watches for incoming files";
    };

    oidcEnvReference = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "1Password reference to an env file with Paperless OIDC settings";
    };

    llmTitleExtraction = {
      enable = lib.mkEnableOption "LLM-based title extraction via post-consume hook";

      openaiKeyReference = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "1Password reference to the OpenAI API key used for title extraction";
      };

      model = lib.mkOption {
        type = lib.types.str;
        default = "gpt-5.4-nano";
        description = "OpenAI model used to extract titles";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.${name}.enable = true";
      }
      {
        assertion = !llmEnabled || cfg.llmTitleExtraction.openaiKeyReference != null;
        message = "homelab.apps.${name}.llmTitleExtraction.openaiKeyReference must be set when llmTitleExtraction.enable = true";
      }
    ];

    services.onepassword-secrets.secrets = {
      paperlessAdminPassword = {
        reference = "op://Homelab/Paperless/adminPassword";
        owner = "paperless";
        group = "paperless";
        mode = "0400";
      };
    } // lib.optionalAttrs (cfg.oidcEnvReference != null) {
      paperlessOidcEnv = {
        reference = cfg.oidcEnvReference;
        owner = "paperless";
        group = "paperless";
        mode = "0400";
      };
    } // lib.optionalAttrs llmEnabled {
      paperlessOpenaiKey = {
        reference = cfg.llmTitleExtraction.openaiKeyReference;
        owner = "paperless";
        group = "paperless";
        mode = "0400";
      };
    };

    # NixOS 24.05 requires manual PostgreSQL configuration
    services.postgresql = {
      enable = true;
      ensureDatabases = [ "paperless" ];
      ensureUsers = [{
        name = "paperless";
        ensureDBOwnership = true;
      }];
    };

    services.paperless = {
      enable = true;
      passwordFile = config.services.onepassword-secrets.secretPaths.paperlessAdminPassword;

      dataDir = cfg.dataDir;
      mediaDir = cfg.mediaDir;
      consumptionDir = cfg.consumptionDir;

      address = "127.0.0.1";
      port = 28981;
      consumptionDirIsPublic = true;  # Allow all users to add documents

      settings = {
        PAPERLESS_URL = "https://${serviceHost}";
        PAPERLESS_ADMIN_USER = "admin";
        PAPERLESS_TIME_ZONE = "Europe/Berlin";
        PAPERLESS_OCR_LANGUAGE = "eng+deu";
        PAPERLESS_OCR_USER_ARGS = {
          optimize = 1;
          pdfa_image_compression = "lossless";
        };
        # doc_pk is the internal DB primary key — stable, auto-assigned, never reused.
        # Paperless 2.x requires Jinja-style {{ }} syntax; old single-brace form is deprecated.
        PAPERLESS_FILENAME_FORMAT = "{{ created_year }}/{{ doc_pk }}";
        PAPERLESS_CONSUMER_IGNORE_PATTERN = [
          ".DS_STORE/*"
          "desktop.ini"
          "._*"
        ];
        PAPERLESS_TASK_WORKERS = 2;
        PAPERLESS_THREADS_PER_WORKER = 2;
      } // lib.optionalAttrs llmEnabled {
        PAPERLESS_POST_CONSUME_SCRIPT = "${llmTitleScript}/bin/paperless-llm-title";
      };
    };

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:${toString config.services.paperless.port}";
    };

    # Make paperless's primary group `homelab` so the upstream services.paperless
    # module's own tmpfiles entries (which derive group from this) emit `homelab`,
    # giving leo read access via the shared group. The `paperless` group still
    # exists separately for legacy references (e.g. secrets group ownership).
    users.users.paperless.group = lib.mkForce "homelab";

    # Explicit rules for the parent dirs of mediaDir/consumptionDir.
    # Without these, the parents get implicit/inconsistent ownership and
    # systemd-tmpfiles aborts with "unsafe path transition", silently skipping
    # the rules below them.
    systemd.tmpfiles.rules = [
      "d ${builtins.dirOf (builtins.dirOf config.services.paperless.mediaDir)} 0750 paperless homelab - -"
      "d ${builtins.dirOf config.services.paperless.mediaDir} 0750 paperless homelab - -"
      # Explicit 0750 on mediaDir: upstream's tmpfiles rule uses `-` for mode
      # (don't change), and paperless historically left this dir at 0711.
      "d ${config.services.paperless.mediaDir} 0750 paperless homelab - -"
    ];

    systemd.services.paperless-scheduler = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    } // lib.optionalAttrs (cfg.oidcEnvReference != null) {
      serviceConfig.EnvironmentFile = config.services.onepassword-secrets.secretPaths.paperlessOidcEnv;
    };

    systemd.services.paperless-web = lib.mkIf (cfg.oidcEnvReference != null) {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
      serviceConfig.EnvironmentFile = config.services.onepassword-secrets.secretPaths.paperlessOidcEnv;
    };

    # The post-consume hook actually runs inside paperless-task-queue (the celery
    # worker), but the consumer also spawns it for some filesystem code paths —
    # set the env on both to be safe.
    systemd.services.paperless-consumer = lib.mkMerge [
      (lib.mkIf (cfg.oidcEnvReference != null) {
        after = [ "opnix-secrets.service" ];
        requires = [ "opnix-secrets.service" ];
        serviceConfig.EnvironmentFile = config.services.onepassword-secrets.secretPaths.paperlessOidcEnv;
      })
      (lib.mkIf llmEnabled { environment = llmEnv; })
    ];

    systemd.services.paperless-task-queue = lib.mkMerge [
      (lib.mkIf (cfg.oidcEnvReference != null) {
        after = [ "opnix-secrets.service" ];
        requires = [ "opnix-secrets.service" ];
        serviceConfig.EnvironmentFile = config.services.onepassword-secrets.secretPaths.paperlessOidcEnv;
      })
      (lib.mkIf llmEnabled { environment = llmEnv; })
    ];
  };
}
