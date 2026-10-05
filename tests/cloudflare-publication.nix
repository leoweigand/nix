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
pkgs.runCommand "cloudflare-publication-check" { nativeBuildInputs = [ pkgs.deno ]; } ''
  cp ${../modules/infra/cloudflare-publication.ts} cloudflare-publication.ts
  cp ${../modules/infra/cloudflare-publication_test.ts} cloudflare-publication_test.ts
  cp ${builtins.head cfg.restartTriggers} manifest.json
  deno check --no-config --no-lock cloudflare-publication.ts cloudflare-publication_test.ts
  deno eval --no-config --no-lock '
    import { validateManifest } from "./cloudflare-publication.ts";
    const manifest = JSON.parse(Deno.readTextFileSync("manifest.json"));
    validateManifest(manifest);
    const hosts = manifest.routes.map(route => route.hostname).sort();
    if (JSON.stringify(hosts) !== JSON.stringify(["auth.leolab.party", "leolab.party", "photos.leolab.party", "webhooks.leolab.party"])) {
      throw new Error("Nix did not generate exactly the opted-in hostnames");
    }
  '
  deno test --no-config --no-lock cloudflare-publication_test.ts
  touch "$out"
''
