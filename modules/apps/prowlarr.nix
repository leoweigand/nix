{ config, lib, ... }:

let
  cfg = config.homelab.apps.prowlarr;
in
{
  options.homelab.apps.prowlarr = {
    enable = lib.mkEnableOption "Prowlarr tracker integration";
    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "prowlarr";
      description = "Prowlarr administration subdomain";
    };
  };

  config = lib.mkIf cfg.enable {
    services.prowlarr = {
      enable = true;
      dataDir = "${config.homelab.mounts.fast}/appdata/prowlarr";
      settings.server = {
        bindAddress = "127.0.0.1";
        port = 9696;
      };
      settings.auth = {
        method = "External";
        required = "Enabled";
      };
    };

    # Indexer access needs no library or download filesystem access.
    systemd.services.prowlarr.serviceConfig.InaccessiblePaths = [ config.homelab.mounts.media ];

    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:9696";
      auth = true;
    };
  };
}
