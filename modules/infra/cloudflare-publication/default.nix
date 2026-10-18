{
  config,
  lib,
  pkgs,
  ...
}:

let
  tunnel = config.homelab.infra.cloudflareTunnel;
  cfg = tunnel.publication;
  edge = config.homelab.infra.edge;
  domain = config.homelab.baseDomain;
  serviceName = "cloudflare-publication";
  stateDirectory = "/var/lib/${serviceName}";
  launcher = pkgs.callPackage ../../../packages/automation/launcher.nix { } {
    name = serviceName;
    script = "modules/infra/cloudflare-publication/cloudflare-publication.ts";
    writePaths = [ stateDirectory ];
    credentialNames = [ "cloudflare-api" ];
  };
  publicProxies = lib.filterAttrs (_: proxy: proxy.public) edge.proxies;
  mkRoute = hostname: service: {
    inherit hostname service;
    originRequest = {
      httpHostHeader = hostname;
    }
    // lib.optionalAttrs (lib.hasPrefix "https:" service) {
      originServerName = hostname;
      noTLSVerify = false;
    };
  };
  routes =
    lib.mapAttrsToList (name: _: mkRoute "${name}.${domain}" "https://127.0.0.1:443") publicProxies
    ++ lib.optional (edge.rootProxy != null && edge.rootProxy.public) (
      mkRoute domain "https://127.0.0.1:443"
    )
    ++ lib.optional edge.webhooksPublic (mkRoute "webhooks.${domain}" "http://127.0.0.1:80");
  manifest = pkgs.writeText "cloudflare-publication.json" (
    builtins.toJSON {
      inherit (cfg)
        accountId
        zoneId
        tunnelId
        adoptExisting
        ;
      inherit domain routes;
      owner = "nix:${config.networking.hostName}:cloudflare-publication";
    }
  );
in
{
  options.homelab.infra.cloudflareTunnel.publication = {
    enable = lib.mkEnableOption "reconciliation of explicitly public edge hosts with Cloudflare";
    accountId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Cloudflare account ID";
    };
    zoneId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Cloudflare zone ID for the edge domain";
    };
    tunnelId = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Existing remotely managed Cloudflare tunnel UUID";
    };
    apiTokenReference = lib.mkOption {
      type = lib.types.str;
      default = edge.cloudflareCredentialsReference;
      description = "1Password API token or dotenv file with DNS Edit, Zone Read and Cloudflare Tunnel Edit permissions";
    };
    adoptExisting = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Public hostnames explicitly authorised to adopt matching tunnel CNAMEs and existing tunnel routes";
    };
  };

  config = lib.mkMerge [
    {
      assertions = [
        {
          assertion = routes == [ ] || cfg.enable;
          message = "Public edge hosts require homelab.infra.cloudflareTunnel.publication.enable";
        }
      ];
    }
    (lib.mkIf cfg.enable {
      assertions = [
        {
          assertion = tunnel.enable && edge.enable;
          message = "Cloudflare publication requires the tunnel and edge proxy to be enabled";
        }
        {
          assertion =
            builtins.match "[a-f0-9]{32}" cfg.accountId != null
            && builtins.match "[a-f0-9]{32}" cfg.zoneId != null;
          message = "Cloudflare publication requires valid accountId and zoneId";
        }
        {
          assertion = builtins.match "[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}" cfg.tunnelId != null;
          message = "Cloudflare publication requires a valid tunnelId UUID";
        }
        {
          assertion = cfg.apiTokenReference != "";
          message = "Cloudflare publication requires apiTokenReference";
        }
        {
          assertion = !edge.webhooksPublic || edge.webhookRoutes != [ ];
          message = "webhooksPublic requires at least one webhook route";
        }
        {
          assertion = lib.all (name: builtins.match "[a-z0-9]([a-z0-9-]*[a-z0-9])?" name != null) (
            builtins.attrNames publicProxies
          );
          message = "Public proxy names must be a single DNS label covered by Cloudflare's domain certificate";
        }
      ];

      services.onepassword-secrets.secrets.cloudflarePublicationToken = {
        reference = cfg.apiTokenReference;
        owner = "root";
        group = "root";
        mode = "0400";
        services = [ serviceName ];
      };

      systemd.services.${serviceName} = {
        description = "Reconcile public edge hostnames with Cloudflare DNS and tunnel routing";
        wantedBy = [ "multi-user.target" ];
        wants = [ "network-online.target" ];
        after = [
          "network-online.target"
          "opnix-secrets.service"
          "caddy.service"
        ];
        requires = [ "opnix-secrets.service" ];
        restartTriggers = [ manifest ];
        serviceConfig = {
          Type = "oneshot";
          ExecStart = "${launcher}/bin/${serviceName} --config ${manifest} --token-file %d/cloudflare-api --state ${stateDirectory}/state.json";
          LoadCredential = [
            "cloudflare-api:${config.services.onepassword-secrets.secretPaths.cloudflarePublicationToken}"
          ];
          StateDirectory = serviceName;
          StateDirectoryMode = "0700";
          DynamicUser = true;
          TimeoutStartSec = "5min";
          NoNewPrivileges = true;
          PrivateTmp = true;
          PrivateDevices = true;
          ProtectHome = true;
          ProtectSystem = "strict";
          ProtectKernelTunables = true;
          ProtectKernelModules = true;
          ProtectControlGroups = true;
          RestrictAddressFamilies = [
            "AF_INET"
            "AF_INET6"
            "AF_UNIX"
          ];
          UMask = "0077";
        };
      };
      # Keep this enabled when the last public flag is removed, so owned records can be withdrawn.
      systemd.timers.${serviceName} = {
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnBootSec = "2min";
          OnUnitInactiveSec = "5min";
          RandomizedDelaySec = "30s";
        };
      };
    })
  ];
}
