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
    ../../modules/services/paperless.nix
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
      bucket = "leolab-backup-picard";
    };
    secrets = {
      s3Credentials = "op://Homelab/Backblaze B2/restic-picard";
      resticPassword = "op://Homelab/Backblaze B2/restic-password";
    };
    jobs = {
      appdata = {
        schedule = "*-*-* 03:00:00";  # Daily at 3:00 AM
        paths = [
          config.storage.directories.backup
          config.storage.directories.appdata
        ];
        exclude = [
          "**/log"
          "**/logs"
          "**/index"
          "**/.cache"
          "**/thumbs"
          "**/thumbnails"
        ];
        pruneOpts = [
          "--keep-daily 7"
          "--keep-weekly 4"
          "--keep-monthly 3"
        ];
      };

      documents = {
        schedule = "Sun *-*-* 04:00:00";  # Weekly on Sundays at 4:00 AM
        paths = [
          config.storage.directories.data
        ];
        exclude = [
          "**/thumbs"
          "**/thumbnails"
          "**/.tmp"
          "**/consume"
        ];
        pruneOpts = [
          "--keep-weekly 4"
          "--keep-monthly 6"
        ];
      };
    };
  };

  system.stateVersion = "24.05";
}
