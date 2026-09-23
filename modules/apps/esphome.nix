{ config, lib, pkgs, ... }:

let
  name = "esphome";
  cfg = config.homelab.apps.${name};
  port = 6052;
  address = "127.0.0.1";
  stateDir = "/var/lib/esphome";
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
      # mDNS responses from devices can be flaky over the picard bridge network;
      # ping-based online checks are more predictable here.
      usePing = true;
      # Keep Device Builder's auxiliary peer-link listener behind Caddy too.
      environment.ESPHOME_REMOTE_BUILD_HOST = "127.0.0.1";
    };

    # ESPHome 2026.8 removed the built-in dashboard, but the nixpkgs module still
    # runs `esphome dashboard`, which now exits immediately. Drive the extracted
    # esphome-device-builder package instead; it takes --host where the old
    # dashboard took --address. Drop this once the module is updated upstream.
    systemd.services.esphome = {
      serviceConfig.ExecStart = lib.mkForce (lib.concatStringsSep " " [
        (lib.getExe pkgs.esphome-device-builder)
        "--host ${address}"
        "--port ${toString port}"
        stateDir
      ]);
      # esphome itself stays on PATH — device-builder shells out to it to compile
      path = [ pkgs.esphome-device-builder ];
    };
  };
}
