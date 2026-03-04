{ config, lib, ... }:

let
  cfg = config.lab.edge;
  domain = config.lab.baseDomain;
in

{
  options.lab.edge = {
    enable = lib.mkEnableOption "Picard edge reverse proxy and TLS";

    acmeEmail = lib.mkOption {
      type = lib.types.str;
      default = "admin@${config.lab.baseDomain}";
      description = "Contact email used for ACME registration";
    };

    cloudflareCredentialsReference = lib.mkOption {
      type = lib.types.str;
      description = "1Password reference for the ACME DNS-01 environment file";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = domain != "";
        message = "lab.baseDomain must be set when lab.edge.enable = true";
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
      };
    };

    networking.firewall = {
      allowedTCPPorts = [
        80
        443
      ];
    };
  };
}
