{
  config,
  lib,
  pkgs,
  ...
}:

let
  mounts = {
    fast = "/mnt/fast";
    media = "/mnt/media";
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
    esphome = [
      "/var/lib/esphome"
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
            path = "/hermes-telegram";
            rewrite = "/hermes-telegram";
            upstream = "http://192.168.2.135:8443";
          }
        ];
      };

      homepage = {
        enable = true;
        categoryOrder = [
          "Smart Home"
          "Services"
          "Entertainment"
        ];
      };

      cloudflareTunnel = {
        enable = true;
        tokenReference = "op://Homelab/Cloudflare/tunnelCredential";
      };

      pocketId = {
        enable = true;
        subdomain = "id";
        encryptionKeyReference = "op://Homelab/Pocket ID/encryption-key";
      };

      # Enrol passkeys and create the gateway client before enabling its service.
      oauth2Proxy = {
        enable = false;
        subdomain = "login";
        envReference = "op://Homelab/OAuth2 Proxy/env";
        allowedGroups = [ "admins" ];
      };

      edge.proxies.auth-check = lib.mkIf config.homelab.infra.oauth2Proxy.enable {
        upstream = "http://127.0.0.1:${toString config.homelab.infra.homepage.port}";
        auth.provider = "oauth2-proxy";
        headerUp.Host = "leolab.party";
      };

      tinyauth = {
        enable = true;
        subdomain = "auth";
        dataDir = "${mounts.fast}/appdata/tinyauth";
        envReference = "op://Homelab/Tinyauth/env";
        userAttributes.leo.email = "leo@leolab.party";
        oidcClients.paperless = {
          clientId = "paperless";
          trustedRedirectUris = [ "https://documents.leolab.party/accounts/oidc/tinyauth/login/callback/" ];
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
        oidcClients.linkding = {
          clientId = "linkding";
          trustedRedirectUris = [ "https://bookmarks.leolab.party/oidc/callback/" ];
        };
      };

      mqtt = {
        enable = true;
        user = "ha";
        passwordReference = "op://Homelab/Home Assistant/mqtt-password";
      };

      notificationGateway = {
        enable = true;
        environmentReference = "op://Homelab/Notification Gateway/env";
      };

      edgeDns = {
        enable = true;
        serial = 2026100502; # Bump whenever DNS names or values change
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
            prepareCommand = ''
              ${pkgs.systemd}/bin/systemctl start podman-linkding.service
              ${pkgs.podman}/bin/podman exec linkding \
                python manage.py full_backup /etc/linkding/data/backup.zip.tmp
              ${pkgs.coreutils}/bin/mv \
                ${mounts.fast}/appdata/linkding/backup.zip.tmp \
                ${mounts.fast}/appdata/linkding/backup.zip
            '';
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

          esphome = {
            schedule = "*-*-* 02:30:00"; # Daily at 2:30 AM, before appdata
            paths = backupPaths.esphome;
            exclude = [
              ".platformio" # PlatformIO toolchains, regenerable
              "**/.esphome/build" # per-device build artifacts, regenerable
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
      jellyfin = {
        enable = true;
        homepage = {
          name = "Jellyfin";
          icon = "jellyfin";
          description = "Movies and TV";
        };
      };
      prowlarr = {
        enable = true;
        homepage = {
          category = "Entertainment";
          name = "Prowlarr";
          icon = "prowlarr";
          description = "Tracker integration";
        };
      };
      sonarr = {
        enable = true;
        homepage = {
          category = "Entertainment";
          name = "Sonarr";
          icon = "sonarr";
          description = "TV library automation";
        };
      };
      radarr = {
        enable = true;
        homepage = {
          category = "Entertainment";
          name = "Radarr";
          icon = "radarr";
          description = "Movie library automation";
        };
      };
      seerr = {
        enable = true;
        subdomain = "discover";
        homepage = {
          category = "Entertainment";
          name = "Discover & Request";
          icon = "seerr";
          description = "Find and request something to watch";
        };
      };
      syncthing = {
        enable = true;
        homepage = {
          category = "Entertainment";
          name = "Syncthing";
          icon = "syncthing";
          description = "File synchronization";
        };
      };
      paperless = {
        enable = true;
        subdomain = "documents";
        dataDir = "${mounts.fast}/appdata/paperless";
        mediaDir = "${mounts.fast}/documents/paperless/library";
        consumptionDir = "${mounts.fast}/documents/paperless/import";
        oidcEnvReference = "op://Homelab/Paperless/oidc-env";
        llmTitleExtraction = {
          enable = true;
          openaiKeyReference = "op://Homelab/Paperless/openai-token";
        };
        homepage = {
          category = "Services";
          name = "Paperless";
          icon = "si-paperlessngx";
          description = "Document archive and OCR";
        };
      };

      homeassistant = {
        enable = true;
        subdomain = "home";
        configDir = "${mounts.fast}/appdata/homeassistant";
        homepage = {
          category = "Smart Home";
          name = "Home Assistant";
          icon = "si-homeassistant";
          description = "Home automation and device control";
        };
      };

      esphome = {
        enable = true;
        homepage = {
          category = "Smart Home";
          name = "ESPHome";
          icon = "si-esphome";
          description = "Build and manage smart-home firmware";
        };
      };

      zigbee2mqtt = {
        enable = true;
        subdomain = "zigbee";
        dataDir = "${mounts.fast}/appdata/ziqbee2mqtt/config"; # existing path, typo intentional
        serialAdapter = "zstack";
        serialPort = "/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_64f09a5b4dbeed11b2996b2e38a92db5-if00-port0";
        homepage = {
          category = "Smart Home";
          name = "Zigbee2MQTT";
          icon = "si-zigbee2mqtt";
          description = "Zigbee device management";
        };
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
        homepage = {
          category = "Services";
          name = "Immich";
          icon = "si-immich";
          description = "Photo and video library";
        };
      };

      linkding = {
        enable = true;
        subdomain = "bookmarks";
        dataDir = "${mounts.fast}/appdata/linkding";
        oidc = {
          enable = true;
          issuerUrl = "https://auth.leolab.party";
          clientSecretReference = "op://Homelab/Linkding/oidc-env";
        };
        homepage = {
          category = "Services";
          name = "Linkding";
          icon = "mdi-bookmark-multiple-outline";
          description = "Bookmark manager";
        };
      };

      silverbullet = {
        enable = true;
        subdomain = "notes";
        spaceDir = "${mounts.fast}/notes";
        homepage = {
          category = "Services";
          name = "SilverBullet";
          icon = "mdi-notebook-outline";
          description = "Markdown notes and knowledge base";
        };
      };

      miniflux = {
        enable = true;
        adminCredentialsReference = "op://Homelab/Miniflux/admin-env";
        oidc = {
          enable = true;
          issuerUrl = "https://auth.leolab.party";
          clientSecretReference = "op://Homelab/Miniflux/oidc-env";
        };
        homepage = {
          category = "Services";
          name = "Miniflux";
          icon = "mdi-rss-box";
          description = "Personal news and feed reader";
        };
      };

    };

    automation.seedboxCleanup = {
      enable = true;
      environmentReference = "op://Homelab/Seedbox Cleanup/env";
    };
    automation.mediaImportNotifications.enable = true;
  };
}
