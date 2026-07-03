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
  packageSet = inputs.hermes-agent.packages.${pkgs.stdenv.hostPlatform.system};
  basePackage =
    if cfg.telegram.enable then
      packageSet.messaging
    else
      packageSet.default;
  hermesVenv = basePackage.passthru.hermesVenv;
  hermesSource = inputs.hermes-agent;

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

        # The initial Telegram service does not use Hermes' web dashboard or TUI.
        # Avoid upstream's currently non-reproducible Linux esbuild TUI build.
        mkdir -p $out/share/hermes-agent/web_dist

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
  };

  config = lib.mkIf cfg.enable {
    services.onepassword-secrets.secrets.hermesAgentEnv = {
      reference = cfg.envReference;
      owner = "hermes";
      group = "hermes";
      mode = "0400";
      services = [ "hermes-agent" ];
    };

    services.hermes-agent = {
      enable = true;
      addToSystemPackages = true;
      package = servicePackage;
      stateDir = cfg.dataDir;
      environmentFiles = [
        config.services.onepassword-secrets.secretPaths.hermesAgentEnv
      ];

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
  };
}
