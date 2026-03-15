{ lib, ... }:

{
  imports = [
    ./homeassistant.nix
    ./immich.nix
    ./openclaw.nix
    ./paperless.nix
    ./zigbee2mqtt.nix
  ];

  options.homelab.apps = lib.mkOption {
    type = lib.types.submodule {
      freeformType = lib.types.attrsOf lib.types.anything;
    };
    default = { };
    description = "Homelab app configuration";
  };
}
