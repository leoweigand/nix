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

  # Refresh collation metadata on template databases before ensureDatabases runs.
  # Needed after glibc upgrades bump the collation version; without this,
  # CREATE DATABASE fails because template1's stored version doesn't match the OS.
  # This is a metadata-only refresh (no index rebuild); full REINDEX is tracked separately.
  systemd.services.postgresql-collation-refresh = {
    description = "Refresh PostgreSQL collation versions on template databases";
    after = [ "postgresql.service" ];
    before = [ "postgresql-setup.service" ];
    wantedBy = [ "postgresql-setup.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "postgres";
      ExecStart = pkgs.writeShellScript "collation-refresh" ''
        psql=${config.services.postgresql.package}/bin/psql
        $psql -c "ALTER DATABASE postgres REFRESH COLLATION VERSION;" || true
        $psql -c "ALTER DATABASE template1 REFRESH COLLATION VERSION;" || true
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

  system.stateVersion = "24.05";
}
