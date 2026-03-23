{ config, lib, ... }:

let
  name = "silverbullet";
  cfg = config.homelab.apps.${name};
in

{
  options.homelab.apps.${name} = {
    enable = lib.mkEnableOption "SilverBullet note-taking service";

    subdomain = lib.mkOption {
      type = lib.types.str;
      default = name;
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
        message = "homelab.baseDomain must be set when homelab.apps.${name}.enable = true";
      }
    ];

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:3000";
      auth = true;
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
