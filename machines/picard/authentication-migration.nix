{ config, lib, ... }:

let
  cfg = config.homelab.infra.authenticationMigration;
  issuer = "https://${config.homelab.infra.pocketId.subdomain}.${config.homelab.baseDomain}";
in
{
  options.homelab.infra.authenticationMigration = {
    gateway = lib.mkEnableOption "the Pocket ID gateway canary after its credentials are saved";
    linkding = lib.mkEnableOption "Linkding sign-in through Pocket ID";
    paperless = lib.mkEnableOption "the additional Pocket ID provider in Paperless";
  };

  config = lib.mkMerge [
    (lib.mkIf cfg.gateway {
      homelab.infra.oauth2Proxy.enable = lib.mkForce true;
      homelab.infra.edge.proxies.login.public = true;
      homelab.infra.edgeDns.serial = lib.mkForce 2026100505;
    })
    (lib.mkIf cfg.linkding {
      homelab.apps.linkding.oidc = {
        issuerUrl = lib.mkForce issuer;
        clientId = "linkding";
        clientSecretReference = lib.mkForce "op://Homelab/Linkding/pocket-id-oidc-env";
        disableLoginForm = false;
      };
    })
    (lib.mkIf cfg.paperless {
      homelab.apps.paperless.oidcEnvReference = lib.mkForce "op://Homelab/Paperless/pocket-id-oidc-env";
    })
  ];
}
