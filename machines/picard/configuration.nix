{ config, lib, modulesPath, ... }:

let
  mounts = config.homelab.mounts;
in

{
  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    ./hardware-configuration.nix
    ../../modules/default.nix # load shared machine and homelab modules
    ./homelab.nix
  ];

  networking = {
    hostName = "picard";

    # Static IP on Unraid network (configure in VM settings, DHCP fallback here)
    useDHCP = lib.mkDefault true;

    # Keep SSH reachable on LAN for bootstrap/recovery
    firewall = {
      enable = true;
      allowedTCPPorts = [
        22
        21064  # Must match the HomeKit Bridge port shown in Home Assistant
      ];
      allowedUDPPorts = [
        5353   # for mdns
      ];
    };
  };

  boot.tmp.cleanOnBoot = true;

  environment.shellAliases = {
    openclaw = "sudo podman exec -it openclaw node dist/index.js";
  };

  fileSystems.${mounts.fast} = {
    device = "nixos-cache";
    fsType = "virtiofs";
  };

  fileSystems.${mounts.slow} = {
    device = "nixos-merged";
    fsType = "virtiofs";
  };

  # Compressed swap in RAM - good for VMs
  zramSwap.enable = true;

  services.postgresqlBackup.location = "${mounts.fast}/backup/postgres";

  # Ensure backup targets exist before first backup run.
  systemd.tmpfiles.rules = [
    "d ${mounts.fast} 0755 root root - -"
    "d ${mounts.slow} 0755 root root - -"
    "d ${mounts.fast}/appdata 0755 root root - -"
    "d ${mounts.fast}/backup 0755 root root - -"
    "d ${mounts.fast}/backup/postgres 0750 postgres postgres - -"
  ];

  system.stateVersion = "24.05";
}
