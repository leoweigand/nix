{ config, lib, pkgs, inputs, ... }:

let
  cfg = config.homelab.apps.immich;
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";

  immichPkgs = import inputs."nixpkgs-immich" {
    system = pkgs.stdenv.hostPlatform.system;
    config = config.nixpkgs.config;
  };
in

{
  imports = [
    (lib.mkAliasOptionModule
      [ "services" "postgresql" "extensions" ]
      [ "services" "postgresql" "extraPlugins" ]
    )
    "${inputs."nixpkgs-immich"}/nixos/modules/services/web-apps/immich.nix"
  ];

  options.homelab.apps.immich = {
    enable = lib.mkEnableOption "Immich photo and video service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "immich";
      description = "Subdomain used to build the Immich external domain";
    };

    mediaDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/photos";
      description = "Directory where Immich stores uploaded media";
    };

  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.immich.enable = true";
      }
    ];

    services.immich = {
      enable = true;
      package = immichPkgs.immich;

      host = "127.0.0.1";
      port = 2283;
      mediaLocation = cfg.mediaDir;
      redis = {
        host = "127.0.0.1";
        port = 6379;
      };

      settings = {
        server.externalDomain = "https://${serviceHost}";
      };
    };

    services.caddy.virtualHosts.${serviceHost} = {
      useACMEHost = config.homelab.baseDomain;
      extraConfig = ''
        reverse_proxy http://${config.services.immich.host}:${toString config.services.immich.port}
      '';
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.mediaDir} 0750 immich immich - -"
    ];

  };
}
