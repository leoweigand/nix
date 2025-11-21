{ config, pkgs, lib, modulesPath, ... }:

{
  # Import shared modules
  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    ../../modules/common.nix
    ../../modules/secrets/1password.nix
    ../../modules/tailscale.nix
    ../../modules/services/paperless.nix
    ../../modules/services/backup.nix
  ];

  # Hardware configuration (Hetzner VPS)
  boot.loader.grub.device = "/dev/sda";
  boot.initrd.availableKernelModules = [ "ata_piix" "uhci_hcd" "xen_blkfront" "vmw_pvscsi" ];
  boot.initrd.kernelModules = [ "nvme" ];
  fileSystems."/" = { device = "/dev/sda1"; fsType = "ext4"; };

  # Networking
  networking = {
    hostName = "riker";

    # Firewall configuration
    # SSH access is provided via Tailscale only (no public SSH)
    # Hetzner console provides emergency access if needed
    firewall = {
      enable = true;
      allowedTCPPorts = [ ];  # No public ports - all access via Tailscale
    };
  };

  # Clean /tmp on boot
  boot.tmp.cleanOnBoot = true;

  # Enable zram swap (compressed swap in RAM - good for VPS)
  zramSwap.enable = true;

  # This value determines the NixOS release from which the default
  # settings for stateful data, like file locations and database versions
  # on your system were taken. It's perfectly fine and recommended to leave
  # this value at the release version of your first install.
  system.stateVersion = "23.11";
}
