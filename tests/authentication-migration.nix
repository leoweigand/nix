{ pkgs, picard }:

let
  original = picard.config;
  candidate =
    (picard.extendModules {
      modules = [
        {
          homelab.infra.authenticationMigration = {
            gateway = true;
            linkding = true;
            paperless = true;
          };
        }
      ];
    }).config;
  protectedUnits = [
    "pocket-id.service"
    "podman-pingvin.service"
    "cloudflared.service"
  ];
  completed =
    (picard.extendModules {
      modules = [
        {
          homelab.infra.authenticationMigration = {
            gateway = true;
            linkding = true;
            paperless = true;
            miniflux = true;
            immich = true;
            gates = true;
          };
        }
      ];
    }).config;
in
assert !original.homelab.infra.oauth2Proxy.enable;
assert candidate.homelab.infra.oauth2Proxy.enable;
assert candidate.homelab.infra.edge.authProvider == "tinyauth";
assert candidate.homelab.infra.tinyauth.enable;
assert candidate.homelab.infra.edge.proxies.login.public;
assert candidate.homelab.apps.linkding.oidc.issuerUrl == "https://auth.leolab.party";
assert
  candidate.homelab.apps.paperless.oidcEnvReference == "op://Homelab/Paperless/pocket-id-oidc-env";
assert candidate.homelab.apps.miniflux.oidc == original.homelab.apps.miniflux.oidc;
assert candidate.homelab.apps.immich.oidc == original.homelab.apps.immich.oidc;
assert pkgs.lib.all (
  name: candidate.systemd.units.${name}.unit.outPath == original.systemd.units.${name}.unit.outPath
) protectedUnits;
assert
  candidate.services.caddy.virtualHosts."share.leolab.party".extraConfig
  == original.services.caddy.virtualHosts."share.leolab.party".extraConfig;
assert
  candidate.services.caddy.virtualHosts."auth.leolab.party".extraConfig
  == original.services.caddy.virtualHosts."auth.leolab.party".extraConfig;
assert candidate.systemd.services.opnix-secrets.reloadIfChanged;
assert candidate.systemd.services.opnix-secrets.serviceConfig.ExecReload != "";
assert completed.homelab.infra.edge.authProvider == "oauth2-proxy";
assert !completed.homelab.apps.miniflux.oidc.autoRegister;
assert !completed.homelab.apps.immich.oidc.autoRegister;
assert completed.homelab.apps.miniflux.oidc.issuerUrl == "https://auth.leolab.party";
assert completed.homelab.apps.immich.oidc.issuerUrl == "https://auth.leolab.party";
assert pkgs.lib.all (
  name: completed.systemd.units.${name}.unit.outPath == original.systemd.units.${name}.unit.outPath
) protectedUnits;
pkgs.runCommand "authentication-migration-check" { } ''
  touch "$out"
''
