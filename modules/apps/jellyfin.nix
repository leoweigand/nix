{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.apps.jellyfin;
  mediaDir = config.homelab.mounts.media;
in
{
  options.homelab.apps.jellyfin = {
    enable = lib.mkEnableOption "Jellyfin media server";
    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "jellyfin";
      description = "Jellyfin subdomain";
    };
  };
  config = lib.mkIf cfg.enable {
    services.jellyfin = {
      enable = true;
      dataDir = "${config.homelab.mounts.fast}/appdata/jellyfin";
      cacheDir = "${config.homelab.mounts.fast}/cache/jellyfin";
      logDir = "/var/log/jellyfin";
      hardwareAcceleration = {
        enable = true;
        type = "vaapi";
        device = "/dev/dri/renderD128";
      };
      forceEncodingConfig = true;
      transcoding = {
        enableHardwareEncoding = true;
        enableToneMapping = false; # Enable only after validating HDR conversion on this GPU.
        throttleTranscoding = true;
        hardwareDecodingCodecs = {
          h264 = true;
          hevc = true;
          hevc10bit = true;
          vp9 = true;
        };
      };
    };
    hardware.graphics.enable = true;
    hardware.firmware = [ pkgs.linux-firmware ];
    boot.kernelModules = [ "amdgpu" ];
    users.users.jellyfin.extraGroups = [
      "render"
      "video"
    ];
    environment.systemPackages = [ pkgs.libva-utils ];
    systemd.services.jellyfin = {
      # Seed network settings without overwriting later administrator changes.
      preStart = lib.mkBefore ''
        if [ ! -e "${config.services.jellyfin.configDir}/network.xml" ]; then
          cp ${pkgs.writeText "jellyfin-network.xml" ''
            <?xml version="1.0" encoding="utf-8"?>
            <NetworkConfiguration>
              <LocalNetworkAddresses><string>127.0.0.1</string></LocalNetworkAddresses>
              <KnownProxies><string>127.0.0.1</string></KnownProxies>
              <EnableRemoteAccess>true</EnableRemoteAccess>
              <EnableIPv4>true</EnableIPv4>
              <EnableIPv6>false</EnableIPv6>
              <AutoDiscovery>false</AutoDiscovery>
              <EnableUPnP>false</EnableUPnP>
            </NetworkConfiguration>
          ''} "${config.services.jellyfin.configDir}/network.xml"
          chmod 600 "${config.services.jellyfin.configDir}/network.xml"
        fi
      '';
      requires = [ "mnt-media.mount" ];
      after = [ "mnt-media.mount" ];
      serviceConfig = {
        InaccessiblePaths = [ mediaDir ];
        BindReadOnlyPaths = [
          "${mediaDir}/library/films:/media/films"
          "${mediaDir}/library/tv:/media/tv"
        ];
      };
    };
    homelab.infra.edge.proxies.${cfg.subdomain}.upstream = "http://127.0.0.1:8096";
  };
}
