{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.infra.swamp;
  swamp = pkgs.callPackage ../../../packages/swamp { };
  stateDir = "/var/lib/swamp";
  repoDir = "${stateDir}/repo";
  zod = pkgs.fetchzip {
    url = "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz";
    hash = "sha256-rXFJjwF7xOLq5/2TA3Rt90qUg0aTPYiW9HE/vZW9uxM=";
  };
  definition = pkgs.writeText "picard-health.yaml" (
    builtins.toJSON (
      builtins.fromJSON (builtins.readFile ./picard-health.json)
      // {
        globalArguments = {
          inherit (cfg)
            mounts
            dnsServer
            dnsNames
            expectedAddress
            endpoints
            ;
        };
      }
    )
  );
  launcher = pkgs.writeShellApplication {
    name = "swamp-picard";
    runtimeInputs = [
      swamp
      pkgs.systemd
      pkgs.util-linux
    ];
    text = ''
      set -a
      # shellcheck disable=SC1091
      source ${config.services.onepassword-secrets.secretPaths.swampEnvironment}
      set +a
      export HOME=${stateDir}
      export SWAMP_HOME=${stateDir}/home
      export SWAMP_REPO_DIR=${repoDir}
      cd "$SWAMP_REPO_DIR"
      exec swamp --no-telemetry "$@"
    '';
  };
in
{
  options.homelab.infra.swamp = {
    enable = lib.mkEnableOption "scheduled Swamp health snapshots";
    schedule = lib.mkOption {
      type = lib.types.str;
      default = "*-*-* *:0/15:00";
      description = "systemd calendar for health snapshots";
    };
    environmentReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password environment file containing the Swamp collective key and signin token";
    };
    mounts = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            path = lib.mkOption { type = lib.types.str; };
            source = lib.mkOption { type = lib.types.str; };
          };
        }
      );
    };
    dnsServer = lib.mkOption { type = lib.types.str; };
    dnsNames = lib.mkOption { type = lib.types.listOf lib.types.str; };
    expectedAddress = lib.mkOption { type = lib.types.str; };
    endpoints = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            name = lib.mkOption { type = lib.types.str; };
            url = lib.mkOption { type = lib.types.str; };
          };
        }
      );
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups.swamp = { };
    users.users.swamp = {
      isSystemUser = true;
      group = "swamp";
      home = stateDir;
    };
    environment.systemPackages = [
      swamp
      launcher
    ];
    services.onepassword-secrets.secrets.swampEnvironment = {
      reference = cfg.environmentReference;
      owner = "swamp";
      group = "swamp";
      mode = "0400";
    };
    systemd.services.swamp-picard-health = {
      description = "Collect Picard health with Swamp";
      after = [
        "network-online.target"
        "opnix-secrets.service"
      ];
      wants = [ "network-online.target" ];
      requires = [ "opnix-secrets.service" ];
      path = [
        swamp
        pkgs.coreutils
      ];
      environment = {
        HOME = stateDir;
        SWAMP_HOME = "${stateDir}/home";
        SWAMP_REPO_DIR = repoDir;
      };
      preStart = ''
        mkdir -p ${repoDir}/extensions/behaviors ${repoDir}/extensions/vendor
        if [ ! -f ${repoDir}/.swamp.yaml ]; then
          ${launcher}/bin/swamp-picard repo init --tool none --no-vault
        fi
        # Extract the bundled runtime before loading any custom extension,
        # then use Nix's Deno so the first run works on a fresh NixOS host.
        if [ ! -f "$SWAMP_HOME/deno/.version" ]; then
          ${launcher}/bin/swamp-picard doctor extensions --json
        fi
        ln -sfn ${pkgs.deno}/bin/deno "$SWAMP_HOME/deno/deno"
        ln -sfn ${zod} ${repoDir}/extensions/vendor/zod
        install -m 0644 ${../../../packages/swamp/extensions/picard-health.ts} ${repoDir}/extensions/behaviors/picard-health.ts
        mkdir -p ${repoDir}/models/@leo/picard-health ${repoDir}/workflows
        install -m 0644 ${definition} ${repoDir}/models/@leo/picard-health/picard-health.yaml
        install -m 0644 ${./workflow-picard-health.yaml} ${repoDir}/workflows/workflow-picard-health.yaml
        ${launcher}/bin/swamp-picard behavior validate picard-health --json
        ${launcher}/bin/swamp-picard workflow validate picard-health --json
      '';
      script = ''
        ${launcher}/bin/swamp-picard workflow run picard-health
        ${launcher}/bin/swamp-picard data gc --yes --json
        ${launcher}/bin/swamp-picard run gc --older-than 7d --yes
      '';
      serviceConfig = {
        Type = "oneshot";
        User = "swamp";
        Group = "swamp";
        StateDirectory = "swamp";
        StateDirectoryMode = "0700";
        WorkingDirectory = stateDir;
        UMask = "0077";
        TimeoutStartSec = "3min";
        MemoryMax = "1G";
        TasksMax = 64;
        NoNewPrivileges = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectHome = true;
        ProtectSystem = "strict";
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictNamespaces = true;
        RestrictSUIDSGID = true;
        RestrictRealtime = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
      };
    };
    systemd.timers.swamp-picard-health = {
      description = "Schedule Picard Swamp health snapshots";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.schedule;
        Persistent = true;
        RandomizedDelaySec = "30s";
      };
    };
  };
}
