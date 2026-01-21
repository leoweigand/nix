{ lib, ... }:

{
  disko.devices = {
    disk = {
      # Primary OS disk
      vda = {
        type = "disk";
        device = "/dev/vda";
        content = {
          type = "gpt";
          partitions = {
            # EFI boot partition
            ESP = {
              priority = 1;
              size = "512M";
              type = "EF00";  # EFI System Partition
              content = {
                type = "filesystem";
                format = "vfat";
                mountpoint = "/boot";
                mountOptions = [ "umask=0077" ];
              };
            };
            # Root filesystem
            root = {
              size = "100%";
              content = {
                type = "filesystem";
                format = "ext4";
                mountpoint = "/";
                mountOptions = [ "defaults" "noatime" ];
              };
            };
          };
        };
      };

      # Fast storage tier (optional second vdisk)
      # Uncomment when you add a second vdisk in Unraid
      # vdb = {
      #   type = "disk";
      #   device = "/dev/vdb";
      #   content = {
      #     type = "gpt";
      #     partitions = {
      #       fast = {
      #         size = "100%";
      #         content = {
      #           type = "filesystem";
      #           format = "ext4";
      #           mountpoint = "/mnt/fast";
      #           mountOptions = [ "defaults" "noatime" ];
      #         };
      #       };
      #     };
      #   };
      # };
    };
  };
}
