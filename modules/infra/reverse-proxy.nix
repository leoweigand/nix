{ config, lib, ... }:

let
  cfg = config.homelab.infra.edge;
  domain = config.homelab.baseDomain;
  tinyauth = config.homelab.infra.tinyauth;
in

{
  options.homelab.infra.edge = {
    enable = lib.mkEnableOption "Picard edge reverse proxy and TLS";

    acmeEmail = lib.mkOption {
      type = lib.types.str;
      default = "admin@${config.homelab.baseDomain}";
      description = "Contact email used for ACME registration";
    };

    cloudflareCredentialsReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference for the ACME DNS-01 environment file";
    };

    proxies = lib.mkOption {
      description = "Reverse-proxy virtual hosts, keyed by subdomain";
      default = { };
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          upstream = lib.mkOption {
            type = lib.types.str;
            description = "Backend URL to proxy requests to";
          };
          auth = lib.mkOption {
            type = lib.types.bool;
            default = false;
            description = "Require tinyauth forward authentication before proxying";
          };
          passUser = lib.mkOption {
            type = lib.types.bool;
            default = false;
            # passUser implies auth; setting this without auth = true is valid
            # and will still gate the request through tinyauth.
            description = "Forward the authenticated Remote-User header to upstream";
          };
        };
      });
    };

    webhookRoutes = lib.mkOption {
      description = "Path-based routes for webhooks.{domain}, each rewriting the path before proxying";
      default = [ ];
      type = lib.types.listOf (lib.types.submodule {
        options = {
          path = lib.mkOption {
            type = lib.types.str;
            description = "URL path to match (e.g. /telegram)";
          };
          rewrite = lib.mkOption {
            type = lib.types.str;
            description = "Path to rewrite matched requests to before proxying";
          };
          upstream = lib.mkOption {
            type = lib.types.str;
            description = "Backend URL";
          };
        };
      });
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = domain != "";
        message = "homelab.baseDomain must be set when homelab.infra.edge.enable = true";
      }
    ];

    services.onepassword-secrets.secrets.cloudflareAcmeEnvironment = {
      reference = cfg.cloudflareCredentialsReference;
      owner = "root";
      group = "root";
      mode = "0400";
    };

    security.acme = {
      acceptTerms = true;
      defaults.email = cfg.acmeEmail;

      certs.${domain} = {
        domain = domain;
        extraDomainNames = [ "*.${domain}" ];
        dnsProvider = "cloudflare";
        dnsPropagationCheck = true;
        dnsResolver = "1.1.1.1:53";
        environmentFile = config.services.onepassword-secrets.secretPaths.cloudflareAcmeEnvironment;
        group = config.services.caddy.group;
        reloadServices = [ "caddy.service" ];
      };
    };

    systemd.services."acme-${domain}" = {
      after = [ "opnix-secrets.service" ];
      requires = [ "opnix-secrets.service" ];
    };

    services.caddy = {
      enable = true;
      globalConfig = ''
        auto_https off
      '';

      virtualHosts = {
        "http://${domain}".extraConfig = ''
          redir https://{host}{uri}
        '';

        "http://*.${domain}".extraConfig = ''
          redir https://{host}{uri}
        '';
      } // lib.optionalAttrs (cfg.webhookRoutes != [ ]) {
        # Plain HTTP so cloudflared can connect without TLS verification issues.
        # Cloudflare terminates TLS at the edge; the tunnel leg is already encrypted.
        "http://webhooks.${domain}" = {
          extraConfig =
            lib.concatMapStrings (route: ''
              handle ${route.path} {
                rewrite * ${route.rewrite}
                reverse_proxy ${route.upstream}
              }
            '') cfg.webhookRoutes
            + ''
              respond 404
            '';
        };
      } // lib.mapAttrs' (subdomain: proxyCfg:
        let
          needsAuth = (proxyCfg.auth || proxyCfg.passUser) && tinyauth.enable;
        in
        lib.nameValuePair "${subdomain}.${domain}" {
          useACMEHost = domain;
          extraConfig = ''
            ${lib.optionalString needsAuth ''
              forward_auth http://127.0.0.1:${toString tinyauth.port} {
                uri /api/auth/caddy
                ${lib.optionalString proxyCfg.passUser "copy_headers Remote-User"}
              }
            ''}
            reverse_proxy ${proxyCfg.upstream}
          '';
        }
      ) cfg.proxies;
    };

    networking.firewall = {
      allowedTCPPorts = [
        80
        443
      ];
    };
  };
}
