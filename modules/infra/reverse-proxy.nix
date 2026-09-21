{ config, lib, ... }:

let
  cfg = config.homelab.infra.edge;
  domain = config.homelab.baseDomain;
  tinyauth = config.homelab.infra.tinyauth;
  authConfigType = lib.types.submodule {
    options = {
      passUser = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Forward the authenticated Remote-User header to upstream";
      };
      bypassPaths = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Request paths to proxy without forward authentication";
      };
    };
  };
  proxyType = lib.types.submodule {
    options = {
      upstream = lib.mkOption {
        type = lib.types.str;
        description = "Backend URL to proxy requests to";
      };
      auth = lib.mkOption {
        type = lib.types.either lib.types.bool authConfigType;
        default = false;
        description = "Whether to require tinyauth, or its detailed configuration";
      };
      headerUp = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        description = "Request headers to set before proxying to the upstream";
      };
      redirects = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        description = "Exact request paths to redirect before authentication and proxying";
      };
    };
  };
  privateProxyType = lib.types.submodule {
    options = {
      upstream = lib.mkOption {
        type = lib.types.str;
        description = "Backend URL to proxy requests to";
      };
      allowedClientRanges = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "Client IP ranges permitted to reach this private proxy";
      };
    };
  };
  proxyExtraConfig =
    proxyCfg:
    let
      authCfg =
        if builtins.isBool proxyCfg.auth then
          {
            enable = proxyCfg.auth;
            passUser = false;
            bypassPaths = [ ];
          }
        else
          {
            enable = true;
            inherit (proxyCfg.auth) passUser bypassPaths;
          };
      needsAuth = authCfg.enable && tinyauth.enable;
      reverseProxy = ''
        reverse_proxy ${proxyCfg.upstream} {
          ${lib.concatMapAttrsStringSep "\n" (name: value: "header_up ${name} ${value}") proxyCfg.headerUp}
        }
      '';
      redirects =
        lib.concatMapAttrsStringSep "\n" (from: to: "redir ${from} ${to} 302") proxyCfg.redirects
        + lib.optionalString (proxyCfg.redirects != { }) "\n";
    in
    redirects
    + (
      if needsAuth && authCfg.bypassPaths != [ ] then
        lib.concatMapStrings (path: ''
          handle ${path} {
            ${reverseProxy}
          }
        '') authCfg.bypassPaths
        + ''
          handle {
            forward_auth http://127.0.0.1:${toString tinyauth.port} {
              uri /api/auth/caddy
              ${lib.optionalString authCfg.passUser "copy_headers Remote-User"}
            }
            ${reverseProxy}
          }
        ''
      else
        ''
          ${lib.optionalString needsAuth ''
            forward_auth http://127.0.0.1:${toString tinyauth.port} {
              uri /api/auth/caddy
              ${lib.optionalString authCfg.passUser "copy_headers Remote-User"}
            }
          ''}
          ${reverseProxy}
        ''
    );
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
      type = lib.types.attrsOf proxyType;
    };

    privateProxies = lib.mkOption {
      description = "TLS reverse-proxy virtual hosts restricted by client IP range";
      default = { };
      type = lib.types.attrsOf privateProxyType;
    };

    rootProxy = lib.mkOption {
      type = lib.types.nullOr proxyType;
      default = null;
      description = "Optional virtual host for the base domain itself";
    };

    webhookRoutes = lib.mkOption {
      description = "Path-based routes for webhooks.{domain}, each rewriting the path before proxying";
      default = [ ];
      type = lib.types.listOf (
        lib.types.submodule {
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
        }
      );
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = domain != "";
        message = "homelab.baseDomain must be set when homelab.infra.edge.enable = true";
      }
      {
        assertion = lib.intersectLists (builtins.attrNames cfg.proxies) (builtins.attrNames cfg.privateProxies) == [ ];
        message = "homelab.infra.edge.proxies and privateProxies must not use the same subdomain";
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
        servers {
          # cloudflared connects from loopback; use Cloudflare's supplied client IP
          # so private routes never mistake a tunnel request for a local one.
          trusted_proxies static 127.0.0.0/8
          trusted_proxies_strict
          client_ip_headers CF-Connecting-IP
        }
      '';

      virtualHosts = {
        "http://${domain}".extraConfig = ''
          redir https://{host}{uri}
        '';

        "http://*.${domain}".extraConfig = ''
          redir https://{host}{uri}
        '';

        # Abort unknown subdomains after TLS handshake rather than serving a blank page
        "https://*.${domain}" = {
          useACMEHost = domain;
          extraConfig = "abort";
        };
      }
      // lib.optionalAttrs (cfg.rootProxy != null) {
        "${domain}" = {
          useACMEHost = domain;
          extraConfig = proxyExtraConfig cfg.rootProxy;
        };
      }
      // lib.optionalAttrs (cfg.webhookRoutes != [ ]) {
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
      }
      // lib.mapAttrs' (
        subdomain: proxyCfg:
        lib.nameValuePair "${subdomain}.${domain}" {
          useACMEHost = domain;
          extraConfig = proxyExtraConfig proxyCfg;
        }
      ) cfg.proxies
      // lib.mapAttrs' (
        subdomain: proxyCfg:
        lib.nameValuePair "${subdomain}.${domain}" {
          useACMEHost = domain;
          extraConfig = ''
            @allowed client_ip ${lib.concatStringsSep " " proxyCfg.allowedClientRanges}
            handle @allowed {
              reverse_proxy ${proxyCfg.upstream}
            }
            respond 403
          '';
        }
      ) cfg.privateProxies;
    };

    networking.firewall = {
      allowedTCPPorts = [
        80
        443
      ];
    };
  };
}
