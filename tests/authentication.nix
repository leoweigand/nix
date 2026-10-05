{ pkgs, picard }:

let
  lib = pkgs.lib;
  gateway = picard.extendModules {
    modules = [
      {
        homelab.infra.oauth2Proxy.enable = lib.mkForce true;
        homelab.infra.edge.proxies.identity = {
          upstream = "http://127.0.0.1:3000";
          auth.passUser = true;
        };
      }
    ];
  };
  cfg = gateway.config;
  unavailable = picard.extendModules {
    modules = [
      {
        homelab.infra.oauth2Proxy.enable = lib.mkForce false;
        # Keep the public login declaration complete while testing a disabled gateway.
        homelab.infra.edge.proxies.login.upstream = "http://127.0.0.1:4180";
      }
    ];
  };
  fixture = pkgs.writeText "authentication-fixture.json" (
    builtins.toJSON {
      sites = lib.genAttrs [ "notes" "prowlarr" "identity" "login" ] (
        name: cfg.services.caddy.virtualHosts."${name}.leolab.party".extraConfig
      );
      oauthCommand = cfg.systemd.services.oauth2-proxy.serviceConfig.ExecStart;
      oauthIssuer = cfg.homelab.infra.oauth2Proxy.issuerUrl;
      pocketSettings = cfg.services.pocket-id.settings;
      pocketBinary = lib.getExe cfg.services.pocket-id.package;
      backupScript = cfg.systemd.services.pocket-id-backup.serviceConfig.ExecStart;
      dataDir = cfg.homelab.infra.pocketId.dataDir;
      backupDir = cfg.homelab.infra.pocketId.backupDir;
      assertionFailures = map (a: a.message) (lib.filter (a: !a.assertion) unavailable.config.assertions);
    }
  );
  python = pkgs.python3.withPackages (ps: [ ps.cryptography ]);
in
pkgs.runCommand "authentication-check"
  {
    nativeBuildInputs = [
      pkgs.caddy
      pkgs.sqlite
      python
    ];
  }
  ''
    python ${./authentication.py} ${fixture}
    touch "$out"
  ''
