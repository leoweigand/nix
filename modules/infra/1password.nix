{
  config,
  lib,
  pkgs,
  ...
}:

{
  services.onepassword-secrets = {
    enable = true;
    tokenFile = "/etc/opnix-token";
  };

  # Wait for network to prevent DNS failures on first boot
  systemd.services.opnix-secrets = {
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    # A switch can stop split DNS before fetching the new secret manifest.
    serviceConfig.BindReadOnlyPaths = [
      "${pkgs.writeText "opnix-resolv.conf" "nameserver 1.1.1.1\nnameserver 1.0.0.1\n"}:/etc/resolv.conf"
    ];
    # Refresh secrets without stopping services which require this oneshot.
    reloadIfChanged = true;
    serviceConfig.ExecReload = pkgs.writeShellScript "opnix-refresh" ''
      set -e
      ${config.systemd.services.opnix-secrets.script}
    '';
    # Keep dependents queued while Opnix retries transient startup failures.
    serviceConfig.RestartMode = "direct";
    # Explicit refreshes are normal when a secret-backed service configuration changes.
    unitConfig.StartLimitIntervalSec = lib.mkForce 0;
  };

  systemd.services.opnix-secrets-restart.serviceConfig.BindReadOnlyPaths =
    config.systemd.services.opnix-secrets.serviceConfig.BindReadOnlyPaths;

  systemd.services.tailscaled-autoconnect = lib.mkIf config.services.tailscale.enable {
    after = [ "opnix-secrets.service" ];
    requires = [ "opnix-secrets.service" ];
  };
}
