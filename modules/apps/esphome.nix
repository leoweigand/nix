{ config, lib, pkgs, ... }:

let
  name = "esphome";
  cfg = config.homelab.apps.${name};
  port = 6052;
  address = "127.0.0.1";
in

{
  options.homelab.apps.${name} = {
    enable = lib.mkEnableOption "ESPHome dashboard";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = name;
      description = "Subdomain used to build the ESPHome URL";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.${name}.enable = true";
      }
    ];

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:${toString port}";
    };

    services.esphome = {
      enable = true;
      package = pkgs.esphome-device-builder;
      inherit address port;
      # Keep Device Builder's auxiliary peer-link listener behind Caddy too.
      remoteBuildAddress = "127.0.0.1";
      trustedDomains = [ "${cfg.subdomain}.${config.homelab.baseDomain}" ];
    };

  };
}
