{ config, lib, pkgs, ... }:

let
  name = "esphome";
  cfg = config.homelab.apps.${name};
  port = 6052;
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
      address = "127.0.0.1";
      inherit port;
      # mDNS responses from devices can be flaky over the picard bridge network;
      # ping-based online checks are more predictable here.
      usePing = true;
    };

    # nixpkgs still launches the classic dashboard removed in ESPHome 2026.8.
    systemd.services.esphome.serviceConfig.ExecStart = lib.mkForce "${lib.getExe pkgs.esphome-device-builder} --host 127.0.0.1 --port ${toString port} /var/lib/esphome";
  };
}
