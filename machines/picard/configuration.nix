{ config, pkgs, lib, modulesPath, ... }:

let
  mounts = {
    fast = "/mnt/fast";
    slow = "/mnt/slow";
  };

  backupPaths = {
    state = [
      "/var/backup"
      "${mounts.fast}/appdata"
    ];
    documents = [
      "${mounts.fast}/documents"
      "${mounts.fast}/photos"
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
    mounts = mounts;

    edge = {
      enable = true;
      acmeEmail = "admin@leolab.party";
      cloudflareCredentialsReference = "op://Homelab/Cloudflare/dnsCredentials";
    };

    mqtt = {
      enable = true;
      user = "ha";
      passwordReference = "op://Homelab/Home Assistant/mqtt-password";
    };

    edgeDns = {
      enable = true;
      lanListenAddress = "192.168.2.4";
      lanAnswerAddress = "192.168.2.4";
      tailnetListenAddress = "100.104.119.103";
      tailnetAnswerAddress = "100.104.119.103";
      upstreamResolvers = [
        "192.168.2.1"
      ];
    };

    services.paperless = {
      enable = true;
    };

    services.homeassistant = {
      enable = true;
      subdomain = "home";
    };

    services.openclaw = {
      enable = true;
      subdomain = "cora";
    };

    services.zigbee2mqtt = {
      enable = true;
      serialAdapter = "zstack";
      serialPort = "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_64f09a5b4dbeed11b2996b2e38a92db5-if00-port0";
    };

    services.immich = {
      enable = true;
      subdomain = "photos";
    };
  };

  # Ensure backup targets exist before first backup run.
  systemd.tmpfiles.rules = [
    "d ${mounts.fast} 0755 root root - -"
    "d ${mounts.slow} 0755 root root - -"
    "d ${mounts.fast}/appdata 0755 root root - -"
    "d /var/backup 0755 root root - -"  # PostgreSQL dump backup path
  ];

  system.stateVersion = "24.05";
}
