{ config, lib, ... }:

{
  imports = [
    ./automation
    ./apps
    ./infra
  ];

  # Containers default to five restarts 100ms apart, then park permanently — a
  # registry blip or a slow secret fetch is enough to leave one dead until it is
  # reset by hand. Back off instead, and never stop retrying, so transient
  # failures heal on their own.
  config.systemd.services = lib.genAttrs (map (name: "podman-${name}") (
    builtins.attrNames config.virtualisation.oci-containers.containers
  )) (_: {
    startLimitIntervalSec = 0;
    serviceConfig = {
      RestartSec = "5s";
      RestartSteps = 5;
      RestartMaxDelaySec = "5min";
    };
  });

  options.homelab = {
    baseDomain = lib.mkOption {
      type = lib.types.str;
      description = "Base domain for app hostnames";
      example = "leolab.party";
    };

    mounts = {
      fast = lib.mkOption {
        type = lib.types.path;
        default = "/mnt/fast";
        description = "Path for fast-tier storage";
      };

      media = lib.mkOption {
        type = lib.types.path;
        default = "/mnt/media";
        description = "Path for the shared media tree";
      };

      slow = lib.mkOption {
        type = lib.types.path;
        default = "/mnt/slow";
        description = "Path for slow-tier storage";
      };
    };
  };
}
