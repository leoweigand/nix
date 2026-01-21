{ config, lib, pkgs, ... }:

let
  # Unraid server hostname (works on both LAN and Tailscale)
  unraidServer = "argusarray";
in

{
  # Storage abstraction layer
  # TODO: Once NFS and second vdisk are configured, change these back to /mnt paths
  storage = {
    enable = true;

    mounts = {
      fast = "/var/lib/picard";   # Temporarily use local storage until second vdisk is added
      normal = "/var/lib/picard"; # Temporarily use local storage until NFS is configured
    };
  };

  # Fast tier: VM-local storage
  # This is a second vdisk attached to the VM, formatted as ext4
  # Create in Unraid: add second vdisk, format during NixOS install
  # TEMPORARILY DISABLED - uncomment once vdb disk is added
  # fileSystems."/mnt/fast" = {
  #   device = "/dev/vdb1";
  #   fsType = "ext4";
  #   options = [ "defaults" "noatime" ];
  # };

  # Normal tier: NFS mounts from Unraid
  # Create these shares on Unraid first:
  #   - /mnt/user/nixos-data (for general service data)
  # TEMPORARILY DISABLED - uncomment once NFS share is created
  # fileSystems."/mnt/normal" = {
  #   device = "${unraidServer}:/mnt/user/nixos-data";
  #   fsType = "nfs";
  #   options = [
  #     "nfsvers=4.2"
  #     "x-systemd.automount"   # Mount on first access
  #     "x-systemd.idle-timeout=600"  # Unmount after 10 min idle
  #     "_netdev"               # Wait for network
  #     "soft"                  # Don't hang on server unreachable
  #     "timeo=15"              # 1.5 second timeout
  #   ];
  # };

  # NFS client support
  services.rpcbind.enable = true;
  boot.supportedFilesystems = [ "nfs" ];

  # Ensure mount points exist
  # TODO: Restore /mnt/fast and /mnt/normal when external storage is configured
  systemd.tmpfiles.rules = [
    "d /var/lib/picard 0755 root root - -"
    "d /mnt/fast 0755 root root - -"
    "d /mnt/normal 0755 root root - -"
  ];
}
