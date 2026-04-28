{ ... }:

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
    notes = [
      "${mounts.fast}/notes"
    ];
    postgres = [
      "${mounts.fast}/backup/postgres"
    ];
  };
in
{
  homelab = {
    baseDomain = "leolab.party";
    mounts = mounts;

    infra = {
      edge = {
        enable = true;
        acmeEmail = "admin@leolab.party";
        cloudflareCredentialsReference = "op://Homelab/Cloudflare/dnsCredentials";
        webhookRoutes = [
          {
            path = "/ha-telegram-bot";
            rewrite = "/api/telegram_webhooks";
            upstream = "http://127.0.0.1:8123";
          }
        ];
      };

      cloudflareTunnel = {
        enable = true;
        tokenReference = "op://Homelab/Cloudflare/tunnelCredential";
      };

      tinyauth = {
        enable = true;
        subdomain = "auth";
        dataDir = "${mounts.fast}/appdata/tinyauth";
        envReference = "op://Homelab/Tinyauth/env";
        oidcClients.paperless = {
          clientId = "paperless";
          trustedRedirectUris = [ "https://paperless.leolab.party/accounts/oidc/tinyauth/login/callback/" ];
        };
        oidcClients.immich = {
          clientId = "immich";
          trustedRedirectUris = [
            "https://photos.leolab.party/auth/login"
            "app.immich:///oauth-callback" # mobile app
          ];
        };
        oidcClients.miniflux = {
          clientId = "miniflux";
          trustedRedirectUris = [ "https://news.leolab.party/oauth2/oidc/callback" ];
        };
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
          postgres = {
            schedule = "*-*-* 01:30:00"; # Daily, after postgresqlBackup runs at midnight
            paths = backupPaths.postgres;
            pruneOpts = [
              "--keep-daily 7"
              "--keep-weekly 4"
              "--keep-monthly 3"
            ];
          };

          appdata = {
            schedule = "*-*-* 03:00:00"; # Daily at 3:00 AM
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
            schedule = "*-*-* 03:30:00"; # Daily at 3:30 AM
            paths = backupPaths.paperless;
            exclude = [
              "**/thumbs"
              "**/thumbnails"
              "**/.tmp"
            ];
            pruneOpts = [
              "--keep-daily 7"
              "--keep-weekly 4"
              "--keep-monthly 3"
            ];
          };

          notes = {
            schedule = "*-*-* 04:00:00"; # Daily at 4:00 AM
            paths = backupPaths.notes;
            pruneOpts = [
              "--keep-daily 7"
              "--keep-weekly 4"
              "--keep-monthly 3"
            ];
          };

          immich = {
            schedule = "*-*-* 04:30:00"; # Daily at 4:30 AM (large library, last to run)
            paths = backupPaths.immich;
            exclude = [
              "**/thumbs"
              "**/thumbnails"
              "**/.tmp"
            ];
            pruneOpts = [
              "--keep-daily 7"
              "--keep-weekly 4"
              "--keep-monthly 3"
            ];
          };
        };
      };
    };

    apps = {
      paperless = {
        enable = true;
        dataDir = "${mounts.fast}/appdata/paperless";
        mediaDir = "${mounts.fast}/documents/paperless/library";
        consumptionDir = "${mounts.fast}/documents/paperless/import";
        oidcEnvReference = "op://Homelab/Paperless/oidc-env";
      };

      homeassistant = {
        enable = true;
        subdomain = "home";
        configDir = "${mounts.fast}/appdata/homeassistant";
      };

      zigbee2mqtt = {
        enable = true;
        subdomain = "zigbee";
        dataDir = "${mounts.fast}/appdata/ziqbee2mqtt/config";  # existing path, typo intentional
        serialAdapter = "zstack";
        serialPort = "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_64f09a5b4dbeed11b2996b2e38a92db5-if00-port0";
      };

      immich = {
        enable = true;
        subdomain = "photos";
        mediaDir = "${mounts.fast}/photos";
        oidc = {
          enable = true;
          issuerUrl = "https://auth.leolab.party";
          clientSecretReference = "op://Homelab/Immich/oidc-client-secret";
        };
      };

      silverbullet = {
        enable = true;
        subdomain = "notes";
        spaceDir = "${mounts.fast}/notes";
      };

      n8n = {
        enable = true;
        envReference = "op://Homelab/N8n/env";
      };

      miniflux = {
        enable = true;
        adminCredentialsReference = "op://Homelab/Miniflux/admin-env";
        oidc = {
          enable = true;
          issuerUrl = "https://auth.leolab.party";
          clientSecretReference = "op://Homelab/Miniflux/oidc-env";
        };
      };
    };
  };
}
