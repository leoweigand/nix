{ config, lib, pkgs, inputs, ... }:

let
  cfg = config.lab.services.immich;
  serviceHost = "${cfg.subdomain}.${config.lab.baseDomain}";

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

  options.lab.services.immich = {
    enable = lib.mkEnableOption "Immich photo and video service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "immich";
      description = "Subdomain used to build the Immich external domain";
    };

    mediaDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/immich";
      description = "Directory where Immich stores uploaded media";
    };

  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.lab.baseDomain != "";
        message = "lab.baseDomain must be set when lab.services.immich.enable = true";
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
      useACMEHost = config.lab.baseDomain;
      extraConfig = ''
        reverse_proxy http://${config.services.immich.host}:${toString config.services.immich.port}
      '';
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.mediaDir} 0750 immich immich - -"
    ];

  };
}
