{ lib, ... }:

{
  imports = [
    ./homeassistant.nix
    ./immich.nix
    ./miniflux.nix
    ./n8n.nix
    ./openclaw.nix
    ./paperless.nix
    ./silverbullet.nix
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
