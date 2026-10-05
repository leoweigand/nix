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
    miniflux = lib.mkEnableOption "Miniflux through Pocket ID after arranging account relinking";
    immich = lib.mkEnableOption "Immich through Pocket ID after arranging account linking";
    gates = lib.mkEnableOption "the shared access gates through the verified Pocket ID gateway";
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
    (lib.mkIf cfg.miniflux {
      homelab.apps.miniflux.oidc = {
        issuerUrl = lib.mkForce issuer;
        clientId = "miniflux";
        clientSecretReference = lib.mkForce "op://Homelab/Miniflux/pocket-id-oidc-env";
        providerName = "LeoLab";
        autoRegister = false;
        disableLocalAuth = false;
      };
    })
    (lib.mkIf cfg.immich {
      homelab.apps.immich.oidc = {
        issuerUrl = lib.mkForce issuer;
        clientId = "immich";
        clientSecretReference = lib.mkForce "op://Homelab/Immich/pocket-id-client-secret";
        buttonText = "Sign in with LeoLab";
        autoRegister = false;
      };
    })
    (lib.mkIf cfg.gates {
      assertions = [
        {
          assertion = cfg.gateway;
          message = "The Pocket ID access gates require the migration gateway stage";
        }
      ];
      homelab.infra.edge.authProvider = "oauth2-proxy";
    })
  ];
}
