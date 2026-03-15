{ config, pkgs, lib, modulesPath, ... }:

let
  mounts = {
    fast = "/mnt/fast";
    slow = "/mnt/slow";
  };

  backupPaths = {
    appdata = [
      "${mounts.fast}/appdata"
    ];
    paperless = [
      "${mounts.fast}/documents/paperless/library"
    ];
    immich = [
      "${mounts.fast}/photos"
    ];
    postgres = [
      "${mounts.fast}/backup/postgres"
    ];
  };
in

{
  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    ./hardware-configuration.nix
    ../../modules/default.nix # load shared machine and homelab modules
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

  homelab = {
    baseDomain = "leolab.party";
    mounts = mounts;

    infra = {
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
            paths = backupPaths.appdata;
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

          paperless = {
            schedule = "Sun *-*-* 04:00:00";  # Weekly on Sundays at 4:00 AM
            paths = backupPaths.paperless;
            exclude = [
              "**/thumbs"
              "**/thumbnails"
              "**/.tmp"
            ];
            pruneOpts = [
              "--keep-weekly 4"
              "--keep-monthly 6"
            ];
          };

          immich = {
            schedule = "Sun *-*-* 04:30:00";  # Weekly on Sundays at 4:30 AM
            paths = backupPaths.immich;
            exclude = [
              "**/thumbs"
              "**/thumbnails"
              "**/.tmp"
            ];
            pruneOpts = [
              "--keep-weekly 4"
              "--keep-monthly 6"
            ];
          };

          postgres = {
            schedule = "*-*-* 01:30:00";  # Daily after PostgreSQL dump jobs
            paths = backupPaths.postgres;
            pruneOpts = [
              "--keep-daily 7"
              "--keep-weekly 4"
              "--keep-monthly 3"
            ];
          };
        };
      };

      auth = {
        enable = true;
        keycloak = {
          dbPasswordReference = "op://Homelab/Keycloak/db-password";
          realm = "homelab";
        };
      };

    };

    apps.paperless = {
      enable = true;
      oidcEnvReference = "op://Homelab/Paperless/oidc-env";
    };

    apps.homeassistant = {
      enable = true;
      subdomain = "home";
    };

    apps.openclaw = {
      enable = true;
      subdomain = "cora";
    };

    apps.zigbee2mqtt = {
      enable = true;
      serialAdapter = "zstack";
      serialPort = "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_64f09a5b4dbeed11b2996b2e38a92db5-if00-port0";
    };

    apps.immich = {
      enable = true;
      subdomain = "photos";
      oidc = {
        enable = true;
        clientSecretReference = "op://Homelab/Immich/oidc-client-secret";
      };
    };
  };

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
