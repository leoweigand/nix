{ lib, ... }:

{
  imports = [
    ./immich.nix
    ./paperless.nix
  ];

  options.lab.services = lib.mkOption {
    type = lib.types.submodule {
      freeformType = lib.types.attrsOf lib.types.anything;
    };
    default = { };
    description = "Lab-managed service configuration";
  };
}
