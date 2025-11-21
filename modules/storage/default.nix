{ lib, config, ... }:

let
  cfg = config.storage;
in

{
  options.storage = {
    enable = lib.mkEnableOption "Storage abstraction layer";

    mounts = {
      fast = lib.mkOption {
        type = lib.types.path;
        default = "/mnt/fast";
        description = "Fast storage tier (NVMe SSD)";
      };

      normal = lib.mkOption {
        type = lib.types.path;
        default = "/mnt/normal";
        description = "Normal storage tier (HDD/SATA SSD)";
      };
    };

    directories = {
      appdata = lib.mkOption {
        type = lib.types.path;
        default = "${cfg.mounts.fast}/appdata";
        description = "Service state, databases, configs (backed up daily)";
      };

      data = lib.mkOption {
        type = lib.types.path;
        default = "${cfg.mounts.normal}/data";
        description = "Large media files (backed up weekly)";
      };

      backup = lib.mkOption {
        type = lib.types.path;
        default = "/var/backup";
        description = "Database dumps";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.tmpfiles.rules = [
      "d ${cfg.directories.appdata} 0755 root root - -"
      "d ${cfg.directories.data} 0755 root root - -"
      "d ${cfg.directories.backup} 0755 root root - -"
    ];
  };
}
