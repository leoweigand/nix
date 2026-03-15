{ lib, ... }:

{
  imports = [
    ./apps
    ./infra
  ];

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

      slow = lib.mkOption {
        type = lib.types.path;
        default = "/mnt/slow";
        description = "Path for slow-tier storage";
      };
    };
  };
}
