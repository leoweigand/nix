{ pkgs, picard }:
let
  enabled = picard.extendModules {
    modules = [
      {
        homelab.infra.now.enable = true;
        homelab.infra.assistant.runtime = "eve";
      }
    ];
  };
  cfg = enabled.config;
  disabled = picard.extendModules {
    modules = [ { homelab.infra.now.enable = pkgs.lib.mkForce false; } ];
  };
  services = cfg.systemd.services;
  domain = cfg.homelab.baseDomain;
  route = cfg.homelab.infra.edge.proxies."*.now";
in
assert !disabled.config.homelab.infra.now.enable;
assert !(disabled.config.systemd.services ? leolab-now);
assert builtins.all (x: x.assertion) cfg.assertions;
assert route.auth.passSubject && !route.public;
assert route.upstream == "unix//run/leolab-now/frontend.sock";
assert builtins.elem "*.now.${domain}" cfg.security.acme.certs.${domain}.extraDomainNames;
assert
  services.leolab-now.serviceConfig.TemporaryFileSystem
  == "/run/leolab-now/builds:rw,size=256M,mode=1777";
assert services.leolab-now.serviceConfig.RuntimeDirectoryMode == "0750";
assert services.leolab-now.serviceConfig.StateDirectoryMode == "0700";
assert services.leolab-now.serviceConfig.Group == cfg.services.caddy.group;
assert builtins.elem "now-token:/var/lib/leolab-now-keys/control-token"
  services.leolab-mcp.serviceConfig.LoadCredential;
assert builtins.elem "/var/lib/leolab-now-backup" cfg.services.restic.backups.now.paths;
pkgs.linkFarm "now-configuration-check" (
  map
    (name: {
      inherit name;
      path = cfg.systemd.units."${name}.service".unit;
    })
    [
      "leolab-now"
      "leolab-now-runtime"
      "leolab-now-store"
      "leolab-now-keys"
      "leolab-mcp"
      "leolab-assistant"
      "restic-backups-now"
    ]
)
