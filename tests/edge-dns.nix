{ pkgs, picard }:

let
  config = picard.config;
  cfg = config.homelab.infra.edgeDns;
  etc = config.environment.etc;
  rootless =
    (picard.extendModules {
      modules = [ { homelab.infra.edge.rootProxy = pkgs.lib.mkForce null; } ];
    }).config.environment.etc;
  secondaries =
    (picard.extendModules {
      modules = [
        {
          homelab.infra.edgeDns.lanSecondaries = [ "127.0.0.5" ];
          homelab.infra.edgeDns.tailnetSecondaries = [ "127.0.0.5" ];
        }
      ];
    }).config.environment.etc;
  fixture = pkgs.writeText "edge-dns-fixture.json" (
    builtins.toJSON {
      corefile = etc."edge-dns/Corefile".text;
      lanZone = etc."edge-dns/lan.zone".text;
      tailnetZone = etc."edge-dns/tailnet.zone".text;
      zone = config.homelab.baseDomain;
      inherit (cfg)
        lanListenAddress
        lanAnswerAddress
        tailnetListenAddress
        tailnetAnswerAddress
        upstreamResolvers
        ;
      privateName = builtins.head (builtins.attrNames config.homelab.infra.edge.proxies);
      offlinePrivateName = builtins.elemAt (builtins.attrNames config.homelab.infra.edge.proxies) 1;
      rootlessCorefile = rootless."edge-dns/Corefile".text;
      rootlessLanZone = rootless."edge-dns/lan.zone".text;
      rootlessTailnetZone = rootless."edge-dns/tailnet.zone".text;
      secondariesCorefile = secondaries."edge-dns/Corefile".text;
    }
  );
  python = pkgs.python3.withPackages (ps: [ ps.dnspython ]);
in
pkgs.runCommand "edge-dns-check"
  {
    nativeBuildInputs = [
      pkgs.coredns
      python
    ];
  }
  ''
    python ${./edge-dns.py} ${fixture}
    touch "$out"
  ''
