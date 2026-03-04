{ config, pkgs, lib, modulesPath, ... }:

let
  backupPaths = {
    state = [
      "/var/backup"
      "/var/lib/immich"
      "/var/lib/paperless"
    ];
    documents = [
      "/var/lib/picard/data"
    ];
  };
in

{
  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    ./hardware-configuration.nix
    ../../modules/default.nix # load homelab configuration
    ../../modules/common.nix
    ../../modules/secrets/1password.nix
    ../../modules/tailscale.nix
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
      state = {
        schedule = "*-*-* 03:00:00";  # Daily at 3:00 AM
        paths = backupPaths.state;
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
        paths = backupPaths.documents;
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

  lab = {
    baseDomain = "leolab.party";

    edge = {
      enable = true;
      acmeEmail = "admin@leolab.party";
      cloudflareCredentialsReference = "op://Homelab/Cloudflare/dnsCredentials";
    };

    services.paperless = {
      enable = true;
      mediaDir = "/var/lib/picard/data/paperless/media";
      consumptionDir = "/var/lib/picard/data/paperless/consume";
    };

    services.immich = {
      enable = true;
      mediaDir = "/var/lib/picard/data/immich";
    };
  };

  # Ensure backup targets exist before first backup run.
  systemd.tmpfiles.rules = [
    "d /var/lib/picard/data 0755 root root - -"  # Bulk data backup path
    "d /var/backup 0755 root root - -"  # PostgreSQL dump backup path
  ];

  system.stateVersion = "24.05";
}
