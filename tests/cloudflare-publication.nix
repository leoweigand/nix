{ pkgs, picard }:

let
  testConfig =
    (picard.extendModules {
      modules = [
        {
          homelab.infra.edge.proxies.photos.public = true;
          homelab.infra.edge.rootProxy.public = true;
          homelab.infra.edge.webhooksPublic = true;
        }
      ];
    }).config;
  original = picard.config;
  acme = original.security.acme.certs."leolab.party";
  acmeTokenPath = original.services.onepassword-secrets.secretPaths.cloudflareAcmeToken;
  cfg = testConfig.systemd.services.cloudflare-publication;
  automation = pkgs.callPackage ../packages/automation/default.nix { };
in
assert cfg.serviceConfig.Type == "oneshot";
assert acme.environmentFile == null;
assert acme.credentialFiles.CF_DNS_API_TOKEN_FILE == acmeTokenPath;
assert builtins.elem "CF_DNS_API_TOKEN_FILE:${acmeTokenPath}"
  original.systemd.services."acme-order-renew-leolab.party".serviceConfig.LoadCredential;
assert
  original.services.onepassword-secrets.secrets.cloudflarePublicationToken.reference
  == original.homelab.infra.edge.cloudflareCredentialsReference;
assert
  testConfig.environment.etc."edge-dns/lan.zone".text
  == original.environment.etc."edge-dns/lan.zone".text;
assert
  testConfig.environment.etc."edge-dns/tailnet.zone".text
  == original.environment.etc."edge-dns/tailnet.zone".text;
assert original.systemd.timers.cloudflare-publication.timerConfig.OnUnitInactiveSec == "5min";
pkgs.runCommand "cloudflare-publication-check" { nativeBuildInputs = [ automation.nodejs ]; } ''
  cp ${builtins.head cfg.restartTriggers} manifest.json
  node --input-type=module -e '
    import { validateManifest } from "${automation}/lib/homelab-automation/modules/infra/cloudflare-publication.ts";
    import { readFileSync } from "node:fs";
    const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
    validateManifest(manifest);
    const hosts = manifest.routes.map(route => route.hostname).sort();
    if (JSON.stringify(hosts) !== JSON.stringify(["auth.leolab.party", "leolab.party", "login.leolab.party", "photos.leolab.party", "share.leolab.party", "webhooks.leolab.party"])) {
      throw new Error("Nix did not generate exactly the opted-in hostnames");
    }
  '
  node --test ${automation}/lib/homelab-automation/modules/infra/cloudflare-publication_test.ts
  touch "$out"
''
