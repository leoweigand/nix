{ lib, ... }:

{
  imports = [
    ./services
  ];

  options.lab = {
    baseDomain = lib.mkOption {
      type = lib.types.str;
      description = "Base domain for lab service hostnames";
      example = "leolab.party";
    };
  };
}
