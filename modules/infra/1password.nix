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
    # Refresh secrets without stopping services which require this oneshot.
    reloadIfChanged = true;
    serviceConfig.ExecReload = pkgs.writeShellScript "opnix-refresh" config.systemd.services.opnix-secrets.script;
    # Keep dependents queued while Opnix retries transient startup failures.
    serviceConfig.RestartMode = "direct";
    # Explicit refreshes are normal when a secret-backed service configuration changes.
    unitConfig.StartLimitIntervalSec = lib.mkForce 0;
  };

  systemd.services.tailscaled-autoconnect = lib.mkIf config.services.tailscale.enable {
    after = [ "opnix-secrets.service" ];
    requires = [ "opnix-secrets.service" ];
  };
}
