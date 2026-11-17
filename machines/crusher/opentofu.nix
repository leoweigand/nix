{ pkgs, ... }:

let
  # Pinned ahead of nixpkgs; drop once nixpkgs ships this version or newer.
  opentofu = pkgs.opentofu.overrideAttrs (_: rec {
    version = "1.13.9";
    src = pkgs.fetchFromGitHub {
      owner = "opentofu";
      repo = "opentofu";
      tag = "v${version}";
      hash = "sha256-FC2CQO7WnHRy02CHypa2a5grZ32ulobNUyg5VG3rWQI=";
    };
  });
in
{
  home-manager.users.leo.home.packages = [ opentofu ];
}
