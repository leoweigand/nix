{ config, lib, ... }:

let
  cfg = config.homelab.apps.silverbullet;
  serviceHost = "${cfg.subdomain}.${config.homelab.baseDomain}";
in

{
  options.homelab.apps.silverbullet = {
    enable = lib.mkEnableOption "SilverBullet note-taking service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "silverbullet";
      description = "Subdomain used to build the SilverBullet URL";
    };

    spaceDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.homelab.mounts.fast}/notes";
      description = "Directory where SilverBullet stores notes (the 'space')";
    };

    imageTag = lib.mkOption {
      type = lib.types.str;
      default = "2.5.2";
      description = "Container image tag for SilverBullet";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = config.homelab.baseDomain != "";
        message = "homelab.baseDomain must be set when homelab.apps.silverbullet.enable = true";
      }
    ];

    services.caddy.virtualHosts.${serviceHost} = {
      useACMEHost = config.homelab.baseDomain;
      extraConfig = ''
        ${lib.optionalString config.homelab.infra.tinyauth.enable ''
          forward_auth http://127.0.0.1:${toString config.homelab.infra.tinyauth.port} {
            uri /api/auth/caddy
          }
        ''}
        reverse_proxy http://127.0.0.1:3000
      '';
    };

    virtualisation = {
      podman.enable = true;
      oci-containers = {
        backend = "podman";
        containers.silverbullet = {
          image = "zefhemel/silverbullet:${cfg.imageTag}";
          autoStart = true;
          extraOptions = [ "--pull=newer" ];
          ports = [ "127.0.0.1:3000:3000" ];
          volumes = [ "${cfg.spaceDir}:/space" ];
        };
      };
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.spaceDir} 0750 root root - -"
    ];
  };
}
