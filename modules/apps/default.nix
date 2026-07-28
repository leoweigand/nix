{ lib, ... }:

{
  imports = [
    ./esphome.nix
    ./hermes-agent.nix
    ./homeassistant.nix
    ./immich.nix
    ./miniflux.nix
    ./paperless
    ./silverbullet.nix
    ./zigbee2mqtt.nix
  ];

  options.homelab.apps = lib.mkOption {
    type = lib.types.submodule {
      freeformType = lib.types.attrsOf (lib.types.submodule {
        options.homepage = lib.mkOption {
          type = lib.types.submodule {
            options = {
              enable = lib.mkOption {
                type = lib.types.bool;
                default = true;
                description = "Publish this app in the Homepage dashboard";
              };

              category = lib.mkOption {
                type = lib.types.str;
                default = "Services";
                description = "Homepage service group";
              };

              name = lib.mkOption {
                type = lib.types.str;
                default = "";
                description = "Friendly name shown in Homepage";
              };

              icon = lib.mkOption {
                type = lib.types.str;
                default = "mdi-application";
                description = "Homepage icon identifier";
              };

              description = lib.mkOption {
                type = lib.types.str;
                default = "";
                description = "Short description shown below the service name";
              };

              href = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Optional URL override for apps without a standard subdomain";
              };
            };
          };
          default = { };
          description = "Presentation metadata published to Homepage";
        };
      });
    };
    default = { };
    description = "Homelab app configuration";
  };
}
