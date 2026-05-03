{ pkgs, ... }:

let
  # Not in nixpkgs; fetch the upstream prebuilt binary for aarch64-darwin
  slimg = pkgs.runCommand "slimg-0.5.1" {
    src = pkgs.fetchurl {
      url = "https://github.com/clroot/slimg/releases/download/v0.5.1/slimg-aarch64-apple-darwin.tar.xz";
      hash = "sha256-uQTJSFA3eCEeQSyd8SjgUT38XkoT2kft9A9chGoicHE=";
    };
  } ''
    mkdir -p $out/bin
    tar -xJf $src --strip-components=1 -C $out/bin slimg-aarch64-apple-darwin/slimg
  '';
in
{
  home.packages = [ slimg ];
}
