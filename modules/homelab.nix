{ lib, ... }:

{
  imports = [
    ./apps
    ./infra

    # Temporary migration aliases. Remove after one deploy cycle.
    (lib.mkRenamedOptionModule [ "lab" "baseDomain" ] [ "homelab" "baseDomain" ])
    (lib.mkRenamedOptionModule [ "lab" "mounts" ] [ "homelab" "mounts" ])
    (lib.mkRenamedOptionModule [ "lab" "services" ] [ "homelab" "apps" ])
    (lib.mkRenamedOptionModule [ "lab" "edge" ] [ "homelab" "infra" "edge" ])
    (lib.mkRenamedOptionModule [ "lab" "edgeDns" ] [ "homelab" "infra" "edgeDns" ])
    (lib.mkRenamedOptionModule [ "lab" "mqtt" ] [ "homelab" "infra" "mqtt" ])
    (lib.mkRenamedOptionModule [ "homelab" "services" ] [ "homelab" "apps" ])
    (lib.mkRenamedOptionModule [ "homelab" "edge" ] [ "homelab" "infra" "edge" ])
    (lib.mkRenamedOptionModule [ "homelab" "edgeDns" ] [ "homelab" "infra" "edgeDns" ])
    (lib.mkRenamedOptionModule [ "homelab" "mqtt" ] [ "homelab" "infra" "mqtt" ])
    (lib.mkRenamedOptionModule [ "backup" ] [ "homelab" "infra" "backup" ])
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
