{ config, lib, pkgs, ... }:

{
  # ============================================================================
  # Paperless-ngx Document Management System
  # ============================================================================
  #
  # Purpose: Digital document organization with OCR and full-text search
  # Access: http://riker:28981 (Tailscale only)
  # Data: /var/lib/paperless
  #
  # Dependencies:
  # - PostgreSQL (manually configured for NixOS 24.05)
  # - Redis (automatically configured)
  # - OpNix secrets (admin password, secret key)
  #
  # Secrets:
  # - op://Homelab/Paperless/adminPassword (web UI admin login)
  # - op://Homelab/Paperless/secretKey (Django SECRET_KEY)
  # ============================================================================

  # --------------------------------------------------------------------------
  # Secret Management
  # --------------------------------------------------------------------------
  services.onepassword-secrets.secrets = {
    # Admin password for web interface login
    paperlessAdminPassword = {
      reference = "op://Homelab/Paperless/adminPassword";
      owner = "paperless";
      group = "paperless";
      mode = "0400";
    };

    # Django secret key as environment file
    # Store in 1Password as: PAPERLESS_SECRET_KEY=<your-secret-key>
    paperlessSecretKey = {
      reference = "op://Homelab/Paperless/secretKey";
      owner = "paperless";
      group = "paperless";
      mode = "0400";
    };
  };

  # --------------------------------------------------------------------------
  # PostgreSQL Database Configuration
  # --------------------------------------------------------------------------
  # Note: database.createLocally option only available in NixOS 24.11+
  # For 24.05, we manually configure PostgreSQL
  services.postgresql = {
    enable = true;
    ensureDatabases = [ "paperless" ];
    ensureUsers = [{
      name = "paperless";
      ensureDBOwnership = true;
    }];
  };

  # --------------------------------------------------------------------------
  # Paperless Service Configuration
  # --------------------------------------------------------------------------
  services.paperless = {
    enable = true;

    # Admin credentials
    passwordFile = config.services.onepassword-secrets.secretPaths.paperlessAdminPassword;

    # Environment file for SECRET_KEY
    # The secret should contain: PAPERLESS_SECRET_KEY=<value>
    environmentFile = config.services.onepassword-secrets.secretPaths.paperlessSecretKey;

    # Network settings (accessible via Tailscale)
    address = "0.0.0.0";  # Listen on all interfaces
    port = 28981;

    # Storage settings
    consumptionDirIsPublic = true;  # Allow all users to add documents

    # Paperless settings
    settings = {
      # Base URL for links in emails and UI
      PAPERLESS_URL = "http://riker:28981";

      # Admin user (created automatically on first start)
      PAPERLESS_ADMIN_USER = "admin";

      # Time zone
      PAPERLESS_TIME_ZONE = "Europe/Berlin";

      # OCR configuration
      PAPERLESS_OCR_LANGUAGE = "eng";  # English OCR
      PAPERLESS_OCR_USER_ARGS = {
        optimize = 1;
        pdfa_image_compression = "lossless";
      };

      # Document organization
      PAPERLESS_FILENAME_FORMAT = "{created_year}/{document_type}/{title}";

      # Ignore patterns for consumption directory
      PAPERLESS_CONSUMER_IGNORE_PATTERN = [
        ".DS_STORE/*"
        "desktop.ini"
        "._*"  # macOS resource forks
      ];

      # Performance tuning (moderate for VPS)
      PAPERLESS_TASK_WORKERS = 2;
      PAPERLESS_THREADS_PER_WORKER = 2;
    };
  };

  # --------------------------------------------------------------------------
  # Service Dependencies
  # --------------------------------------------------------------------------
  # Ensure paperless waits for secrets to be available
  systemd.services.paperless-scheduler = {
    after = [ "opnix-secrets.service" ];
    requires = [ "opnix-secrets.service" ];
  };

  # --------------------------------------------------------------------------
  # Firewall Configuration
  # --------------------------------------------------------------------------
  # Paperless is accessible via Tailscale only.
  # The trustedInterfaces setting in modules/tailscale.nix allows
  # all traffic from tailscale0 interface.
  #
  # No public firewall ports needed.
}
