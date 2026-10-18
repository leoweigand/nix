{ pkgs, picard }:

let
  config =
    (picard.extendModules {
      modules = [
        {
          homelab.infra.aiGateway = {
            enable = true;
            apiKeyReference = "op://Homelab/OpenCode Zen/credential";
          };
          homelab.infra.edge.internalProxies.probe.upstream = "http://127.0.0.1:9088";
        }
      ];
    }).config;
  collision =
    (picard.extendModules {
      modules = [
        {
          homelab.infra.edge.internalProxies.probe.upstream = "http://127.0.0.1:9088";
          homelab.infra.edge.proxies."bypass.internal".upstream = "http://127.0.0.1:9088";
        }
      ];
    }).config;
  fixture = pkgs.writeText "internal-api-fixture.json" (
    builtins.toJSON {
      namespaceReserved = pkgs.lib.any (
        a: !a.assertion && a.message == "The internal namespace is reserved for edge.internalProxies"
      ) collision.assertions;
      caddy = config.services.caddy.virtualHosts."https://*.internal.leolab.party".extraConfig;
      tls = config.security.acme.certs."leolab.party".extraDomainNames;
      lan = config.environment.etc."edge-dns/lan.zone".text;
      tailnet = config.environment.etc."edge-dns/tailnet.zone".text;
      legacyUnchanged =
        config.services.caddy.virtualHosts."notifications.leolab.party".extraConfig
        == picard.config.services.caddy.virtualHosts."notifications.leolab.party".extraConfig;
    }
  );
in
pkgs.runCommand "internal-api-check"
  {
    nativeBuildInputs = [
      pkgs.caddy
      pkgs.python3
    ];
  }
  ''
    python ${./internal-api.py} ${fixture}
    touch "$out"
  ''
