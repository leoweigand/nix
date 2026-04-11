{ config, lib, pkgs, modulesPath, ... }:

let
  mounts = config.homelab.mounts;
in

{
  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    ./hardware-configuration.nix
    ../../modules/default.nix # load shared machine and homelab modules
    ./homelab.nix
  ];

  networking = {
    hostName = "picard";

    # Static IP on Unraid network (configure in VM settings, DHCP fallback here)
    useDHCP = lib.mkDefault true;

    # Keep SSH reachable on LAN for bootstrap/recovery
    firewall = {
      enable = true;
      allowedTCPPorts = [
        22
        21064  # HomeKit Bridge
        21065  # Dedicated LG TV HomeKit accessory
      ];
      allowedUDPPorts = [
        5353   # for mdns
      ];
    };
  };

  boot.tmp.cleanOnBoot = true;

  fileSystems.${mounts.fast} = {
    device = "nixos-cache";
    fsType = "virtiofs";
  };

  fileSystems.${mounts.slow} = {
    device = "nixos-merged";
    fsType = "virtiofs";
  };

  # Compressed swap in RAM - good for VMs
  zramSwap.enable = true;

  services.postgresqlBackup.location = "${mounts.fast}/backup/postgres";

  # Refresh collation metadata on ALL databases before ensureDatabases runs.
  # Needed after glibc upgrades bump the collation version; without this,
  # CREATE DATABASE fails because template1's stored version doesn't match the OS.
  # This is metadata-only (no index rebuild); one-time REINDEX is needed separately.
  systemd.services.postgresql-collation-refresh = {
    description = "Refresh PostgreSQL collation versions on all databases";
    after = [ "postgresql.service" ];
    before = [ "postgresql-setup.service" ];
    wantedBy = [ "postgresql-setup.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "postgres";
      ExecStart = pkgs.writeShellScript "collation-refresh" ''
        psql=${config.services.postgresql.package}/bin/psql
        # Refresh every database so stored collation version matches the OS
        for db in $($psql -AtqX -c "SELECT datname FROM pg_database WHERE datallowconn"); do
          $psql -c "ALTER DATABASE \"$db\" REFRESH COLLATION VERSION;" || true
        done
      '';
    };
  };

  systemd.services.postgresql-setup = {
    after = lib.mkAfter [ "postgresql-collation-refresh.service" ];
  };

  # Ensure backup targets exist before first backup run.
  systemd.tmpfiles.rules = [
    "d ${mounts.fast} 0755 root root - -"
    "d ${mounts.slow} 0755 root root - -"
    "d ${mounts.fast}/appdata 0755 root root - -"
    "d ${mounts.fast}/backup 0755 root root - -"
    "d ${mounts.fast}/backup/postgres 0750 postgres postgres - -"
  ];

  home-manager.users.leo.home.stateVersion = "24.05";

  system.stateVersion = "24.05";
}
