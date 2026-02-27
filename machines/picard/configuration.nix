{ config, pkgs, lib, modulesPath, ... }:

{
  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    ./hardware-configuration.nix
    ./filesystems.nix  # NFS and storage module config (disko handles disk partitions)
    ../../modules/common.nix
    ../../modules/secrets/1password.nix
    ../../modules/storage
    ../../modules/tailscale.nix
    # ../../modules/services/paperless.nix
    ../../modules/services/backup.nix
  ];

  networking = {
    hostName = "picard";

    # Static IP on Unraid network (configure in VM settings, DHCP fallback here)
    useDHCP = lib.mkDefault true;

    # Keep SSH reachable on LAN for bootstrap/recovery
    firewall = {
      enable = true;
      allowedTCPPorts = [ 22 ];
    };
  };

  boot.tmp.cleanOnBoot = true;

  # Compressed swap in RAM - good for VMs
  zramSwap.enable = true;

  # Backups to Backblaze B2
  backup = {
    enable = true;
    s3 = {
      endpoint = "s3.eu-central-003.backblazeb2.com";
      bucket = "leolab-backup";
    };
    secrets = {
      s3Credentials = "op://Homelab/Backblaze Backup/s3Credentials";
      resticPassword = "op://Homelab/Backblaze Backup/resticPassword";
    };
  };

  system.stateVersion = "24.05";
}
