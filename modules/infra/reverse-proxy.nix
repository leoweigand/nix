{ config, lib, ... }:

let
  cfg = config.homelab.infra.edge;
  domain = config.homelab.baseDomain;
  tinyauth = config.homelab.infra.tinyauth;
  oauth2Proxy = config.homelab.infra.oauth2Proxy;
  providerType = lib.types.enum [
    "tinyauth"
    "oauth2-proxy"
  ];
  authProvider =
    proxyCfg:
    if builtins.isBool proxyCfg.auth || proxyCfg.auth.provider == null then
      cfg.authProvider
    else
      proxyCfg.auth.provider;
  requiresAuth = proxyCfg: if builtins.isBool proxyCfg.auth then proxyCfg.auth else true;
  providerEnabled = provider: if provider == "tinyauth" then tinyauth.enable else oauth2Proxy.enable;
  authConfigType = lib.types.submodule {
    options = {
      provider = lib.mkOption {
        type = lib.types.nullOr providerType;
        default = null;
        description = "Optional gateway override while migrating individual routes";
      };
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
      public = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Publish this hostname through the managed Cloudflare DNS record and tunnel route";
      };
      upstream = lib.mkOption {
        type = lib.types.str;
        description = "Backend URL to proxy requests to";
      };
      auth = lib.mkOption {
        type = lib.types.either lib.types.bool authConfigType;
        default = false;
        description = "Whether to require the authentication gateway, or its detailed configuration";
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
      needsAuth = authCfg.enable;
      provider = authProvider proxyCfg;
      authGate =
        if provider == "tinyauth" then
          ''
            forward_auth http://127.0.0.1:${toString tinyauth.port} {
              uri /api/auth/caddy
              ${lib.optionalString authCfg.passUser "copy_headers Remote-User"}
            }
          ''
        else
          ''
            # Expanded forward_auth lets renewal cookies reach the browser.
            reverse_proxy http://127.0.0.1:${toString oauth2Proxy.port} {
              method GET
              # Drop the app query so its rd parameter cannot override our return URL.
              rewrite /?
              header_up X-Forwarded-Method {method}
              header_up X-Forwarded-Uri {uri}
              header_up X-Auth-Request-Redirect https://{host}{uri}
              @authenticated status 2xx
              handle_response @authenticated {
                copy_response_headers {
                  include Set-Cookie
                }
                ${lib.optionalString authCfg.passUser "request_header Remote-User {rp.header.X-Auth-Request-Preferred-Username}"}
              }
            }
          '';
      reverseProxy = ''
        reverse_proxy ${proxyCfg.upstream} {
          ${lib.concatMapAttrsStringSep "\n" (name: value: "header_up ${name} ${value}") proxyCfg.headerUp}
        }
      '';
      redirects =
        lib.concatMapAttrsStringSep "\n" (from: to: "redir ${from} ${to} 302") proxyCfg.redirects
        + lib.optionalString (proxyCfg.redirects != { }) "\n";
      protectedProxy = ''
        route {
          request_header -Remote-User
          ${authGate}
          ${reverseProxy}
        }
      '';
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
            ${protectedProxy}
          }
        ''
      else
        ''
          ${if needsAuth then protectedProxy else reverseProxy}
        ''
    );
in

{
  options.homelab.infra.edge = {
    enable = lib.mkEnableOption "Picard edge reverse proxy and TLS";

    authProvider = lib.mkOption {
      type = providerType;
      default = "tinyauth";
      description = "Default authentication gateway for protected routes";
    };

    acmeEmail = lib.mkOption {
      type = lib.types.str;
      default = "admin@${config.homelab.baseDomain}";
      description = "Contact email used for ACME registration";
    };

    cloudflareCredentialsReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference to the raw Cloudflare API token for ACME DNS-01";
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

    webhooksPublic = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Publish webhooks.{domain} through Cloudflare; existing dashboard routes are not adopted automatically";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = domain != "";
        message = "homelab.baseDomain must be set when homelab.infra.edge.enable = true";
      }
      {
        assertion =
          lib.intersectLists (builtins.attrNames cfg.proxies) (builtins.attrNames cfg.privateProxies) == [ ];
        message = "homelab.infra.edge.proxies and privateProxies must not use the same subdomain";
      }
    ]
    ++ lib.mapAttrsToList (name: proxyCfg: {
      assertion = !requiresAuth proxyCfg || providerEnabled (authProvider proxyCfg);
      message = "Protected edge route ${name} requires its ${authProvider proxyCfg} authentication gateway to be enabled";
    }) (cfg.proxies // lib.optionalAttrs (cfg.rootProxy != null) { "<root>" = cfg.rootProxy; });

    services.onepassword-secrets.secrets.cloudflareAcmeToken = {
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
        # Lego reads the raw token through a private systemd credential file.
        credentialFiles.CF_DNS_API_TOKEN_FILE =
          config.services.onepassword-secrets.secretPaths.cloudflareAcmeToken;
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
      # Caddy binds UDP 443 and advertises `Alt-Svc: h3=":443"` by default.
      # Without this the firewall silently drops QUIC, so clients that cached
      # the Alt-Svc hint stall on HTTP/3 instead of falling back to TCP.
      allowedUDPPorts = [ 443 ];
    };
  };
}
