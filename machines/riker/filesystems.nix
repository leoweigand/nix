{ config, ... }:

{
  storage = {
    enable = true;

    # Single disk - both tiers on same filesystem
    mounts = {
      fast = "/mnt/storage";
      normal = "/mnt/storage";
    };
  };

  systemd.tmpfiles.rules = [
    "d /mnt/storage 0755 root root - -"
  ];
}
