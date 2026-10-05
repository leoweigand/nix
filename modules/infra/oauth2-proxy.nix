{ config, lib, ... }:

let
  cfg = config.homelab.infra.oauth2Proxy;
  domain = config.homelab.baseDomain;
  serviceHost = "${cfg.subdomain}.${domain}";
  edge = config.homelab.infra.edge;
  protectedHosts = lib.filterAttrs (
    _: proxy: if builtins.isBool proxy.auth then proxy.auth else true
  ) edge.proxies;
in
{
  options.homelab.infra.oauth2Proxy = {
    enable = lib.mkEnableOption "Pocket ID authentication gateway";
    subdomain = lib.mkOption {
      type = lib.types.str;
      default = "login";
      description = "Hostname for the gateway's sign-in and callback endpoints";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 4180;
      description = "Loopback port for OAuth2 Proxy";
    };
    issuerUrl = lib.mkOption {
      type = lib.types.str;
      default = "https://${config.homelab.infra.pocketId.subdomain}.${domain}";
      description = "OIDC issuer for the authentication gateway";
    };
    envReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password env file with OAUTH2_PROXY_CLIENT_ID, OAUTH2_PROXY_CLIENT_SECRET and OAUTH2_PROXY_COOKIE_SECRET";
    };
    allowedGroups = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ "admins" ];
      description = "Pocket ID groups allowed through the gateway";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = edge.enable && domain != "";
        message = "OAuth2 Proxy requires the HTTPS edge and a base domain";
      }
      {
        assertion = cfg.allowedGroups != [ ];
        message = "OAuth2 Proxy must restrict access to at least one Pocket ID group";
      }
    ];
    services.onepassword-secrets.secrets.oauth2ProxyEnv = {
      reference = cfg.envReference;
      owner = "root";
      group = "root";
      mode = "0400";
    };
    services.oauth2-proxy = {
      enable = true;
      provider = "oidc";
      oidcIssuerUrl = cfg.issuerUrl;
      keyFile = config.services.onepassword-secrets.secretPaths.oauth2ProxyEnv;
      httpAddress = "127.0.0.1:${toString cfg.port}";
      reverseProxy = true;
      trustedProxyIP = [ "127.0.0.1/32" ];
      redirectURL = "https://${serviceHost}/oauth2/callback";
      scope = "openid email profile groups";
      upstream = [ "static://202" ];
      email.domains = [ "*" ];
      passBasicAuth = false;
      setXauthrequest = true;
      cookie = {
        domain = ".${domain}";
        name = "__Secure-leolab_gateway";
        secure = true;
        httpOnly = true;
        expire = "12h";
        refresh = "1h";
      };
      extraConfig = {
        allowed-group = cfg.allowedGroups;
        code-challenge-method = "S256";
        insecure-oidc-skip-nonce = false;
        skip-provider-button = true;
        cookie-samesite = "lax";
        # Exact hosts keep a newly added public subdomain from becoming a redirect target.
        whitelist-domain = [
          serviceHost
        ]
        ++ lib.mapAttrsToList (name: _: "${name}.${domain}") protectedHosts
        ++ lib.optional (edge.rootProxy != null) domain;
      };
    };
    systemd.services.oauth2-proxy = {
      after = [
        "opnix-secrets.service"
        "pocket-id.service"
        "edge-dns.service"
        "caddy.service"
      ];
      requires = [ "opnix-secrets.service" ];
      wants = [ "pocket-id.service" "edge-dns.service" "caddy.service" ];
    };
    homelab.infra.edge.proxies.${cfg.subdomain} = {
      upstream = "http://127.0.0.1:${toString cfg.port}";
    };
  };
}
