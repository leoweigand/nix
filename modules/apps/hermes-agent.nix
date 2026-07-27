{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:

let
  name = "hermes-agent";
  cfg = config.homelab.apps.${name};
  homeassistantCfg = config.homelab.apps.homeassistant;
  packageSet = inputs.hermes-agent.packages.${pkgs.stdenv.hostPlatform.system};
  basePackage =
    if cfg.telegram.enable then
      packageSet.messaging
    else
      packageSet.default;
  hermesVenv = basePackage.passthru.hermesVenv;
  hermesSource = inputs.hermes-agent;

  # Hermes' lockfile declares this optional package but omits its package
  # record. Inject the pinned binary after npm's offline install instead of
  # rebuilding the entire workspace lockfile.
  linuxEsbuild = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.28.1.tgz";
    hash = "sha512-u/anNYF2mmVOEDwLtnQ1wOr3EZ9sTNGLWrsYGYwHWzGA3Si84IOkHXlbWTD1NB+9/1lcnweYKO54uhxZydNzfA==";
  };
  hermesWeb = basePackage.passthru.hermesWeb.overrideAttrs (old: {
    npmRebuildFlags = [ "--ignore-scripts" ];
    preBuild = (old.preBuild or "") + ''
      mkdir -p node_modules/@esbuild/linux-x64
      tar --extract --gzip --file ${linuxEsbuild} \
        --directory node_modules/@esbuild/linux-x64 --strip-components=1
    '';
  });

  bundledSkills = lib.cleanSourceWith {
    src = hermesSource + "/skills";
    filter = path: _type: !(lib.hasInfix "/index-cache/" path);
  };
  bundledPlugins = lib.cleanSourceWith {
    src = hermesSource + "/plugins";
    filter = path: _type: !(lib.hasInfix "/__pycache__/" path);
  };
  bundledLocales = lib.cleanSource (hermesSource + "/locales");

  runtimeDeps = [
    pkgs.nodejs_22
    pkgs.ripgrep
    pkgs.git
    pkgs.openssh
    pkgs.ffmpeg
    pkgs.tirith
  ] ++ lib.optionals pkgs.stdenv.isLinux [
    pkgs.wl-clipboard
    pkgs.xclip
  ];

  servicePackage = pkgs.stdenv.mkDerivation {
    pname = "hermes-agent";
    inherit (basePackage) version;

    dontUnpack = true;
    dontBuild = true;
    nativeBuildInputs = [ pkgs.makeWrapper ];

    installPhase =
      let
        runtimePath = lib.makeBinPath runtimeDeps;
        revisionFlag = lib.optionalString (inputs.hermes-agent ? rev) ''
          --set HERMES_REVISION ${inputs.hermes-agent.rev} \
        '';
        wrapHermes = name: ''
          makeWrapper ${hermesVenv}/bin/${name} $out/bin/${name} \
            --suffix PATH : "${runtimePath}" \
            --set HERMES_BUNDLED_SKILLS $out/share/hermes-agent/skills \
            --set HERMES_BUNDLED_PLUGINS $out/share/hermes-agent/plugins \
            --set HERMES_BUNDLED_LOCALES $out/share/hermes-agent/locales \
            --set HERMES_WEB_DIST $out/share/hermes-agent/web_dist \
            --set HERMES_TUI_DIR $out/ui-tui \
            --set HERMES_PYTHON ${hermesVenv}/bin/python3 \
            --set HERMES_NODE ${lib.getExe pkgs.nodejs_22} \
            ${revisionFlag}
        '';
      in
      ''
        runHook preInstall

        mkdir -p $out/share/hermes-agent $out/bin $out/ui-tui
        cp -r ${bundledSkills} $out/share/hermes-agent/skills
        cp -r ${bundledPlugins} $out/share/hermes-agent/plugins
        cp -r ${bundledLocales} $out/share/hermes-agent/locales

        ${lib.optionalString cfg.dashboard.enable ''
          cp -r ${hermesWeb} $out/share/hermes-agent/web_dist
        ''}

        ${lib.concatMapStringsSep "\n" wrapHermes [
          "hermes"
          "hermes-agent"
          "hermes-acp"
        ]}

        runHook postInstall
      '';

    meta = basePackage.meta or { };
  };
in

{
  options.homelab.apps.${name} = {
    enable = lib.mkEnableOption "Hermes Agent service";

    dataDir = lib.mkOption {
      type = lib.types.str;
      description = "Directory where Hermes stores state, auth, and workspace data";
    };

    envReference = lib.mkOption {
      type = lib.types.str;
      description = ''
        1Password reference to an env file for Hermes secrets, for example:
          TELEGRAM_BOT_TOKEN=<token>
          TELEGRAM_ALLOWED_USERS=<telegram-user-id>
      '';
      example = "op://Homelab/Hermes Agent/env";
    };

    provider = lib.mkOption {
      type = lib.types.str;
      default = "openai-codex";
      description = "Hermes provider id for the primary model";
    };

    model = lib.mkOption {
      type = lib.types.str;
      default = "gpt-5.4";
      description = "Default model id used by Hermes";
    };

    telegram.enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable Hermes messaging dependencies for Telegram";
    };

    dashboard = {
      enable = lib.mkEnableOption "Hermes web dashboard";

      subdomain = lib.mkOption {
        type = lib.types.str;
        default = "hermes";
        description = "Subdomain used to expose the Hermes web dashboard";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 9119;
        description = "Local port where the Hermes web dashboard listens";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    services.onepassword-secrets.secrets.hermesAgentEnv = {
      reference = cfg.envReference;
      owner = "hermes";
      group = "hermes";
      mode = "0400";
      services = [
        "hermes-agent"
      ] ++ lib.optional cfg.dashboard.enable "hermes-dashboard";
    };

    services.hermes-agent = {
      enable = true;
      addToSystemPackages = true;
      package = servicePackage;
      stateDir = cfg.dataDir;
      environmentFiles = [
        config.services.onepassword-secrets.secretPaths.hermesAgentEnv
      ];
      environment = lib.optionalAttrs homeassistantCfg.enable {
        HASS_URL = config.homelab.infra.edge.proxies.${homeassistantCfg.subdomain}.upstream;
      };

      settings = {
        model = {
          provider = cfg.provider;
          default = cfg.model;
        };

        terminal.cwd = "${cfg.dataDir}/workspace";
      };
    };

    systemd.services.hermes-agent = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];

      environment = lib.mkForce {
        HOME = cfg.dataDir;
        HERMES_HOME = "${cfg.dataDir}/.hermes";
        HERMES_MANAGED = "true";
      };

      serviceConfig = {
        EnvironmentFile = config.services.onepassword-secrets.secretPaths.hermesAgentEnv;
        TimeoutStopSec = "210s";
      };
    };

    assertions = lib.optional cfg.dashboard.enable {
      assertion =
        config.homelab.infra.edge.enable
        && config.homelab.infra.tinyauth.enable;
      message = "homelab.apps.hermes-agent.dashboard.enable requires the edge reverse proxy and Tinyauth";
    };

    homelab.infra.edge.proxies.${cfg.dashboard.subdomain} = lib.mkIf cfg.dashboard.enable {
      upstream = "http://127.0.0.1:${toString cfg.dashboard.port}";
      auth = true;
      # Hermes validates Host and Origin against its loopback bind. Keep the
      # public forwarded headers intact while presenting the internal origin.
      headerUp = {
        Host = "127.0.0.1:${toString cfg.dashboard.port}";
        Origin = "https://127.0.0.1:${toString cfg.dashboard.port}";
      };
    };

    systemd.services.hermes-dashboard = lib.mkIf cfg.dashboard.enable {
      description = "Hermes Agent web dashboard";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "opnix-secrets.service"
      ];
      wants = [ "network-online.target" ];
      requires = [ "opnix-secrets.service" ];

      environment = {
        HOME = cfg.dataDir;
        HERMES_HOME = "${cfg.dataDir}/.hermes";
        HERMES_MANAGED = "true";
      };

      serviceConfig = {
        User = "hermes";
        Group = "hermes";
        WorkingDirectory = "${cfg.dataDir}/workspace";
        EnvironmentFile = config.services.onepassword-secrets.secretPaths.hermesAgentEnv;
        ExecStart = lib.concatStringsSep " " [
          "${servicePackage}/bin/hermes"
          "dashboard"
          "--host 127.0.0.1"
          "--port ${toString cfg.dashboard.port}"
          "--no-open"
        ];
        Restart = "always";
        RestartSec = 5;
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = false;
        ReadWritePaths = [ cfg.dataDir ];
        PrivateTmp = true;
      };

      path = [
        servicePackage
        pkgs.bash
        pkgs.coreutils
        pkgs.git
      ];
    };
  };
}
