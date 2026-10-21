{ pkgs, ... }:

let
  version = "0.7.0";
  tsql = pkgs.stdenvNoCC.mkDerivation {
    pname = "tsql";
    inherit version;

    src = pkgs.fetchurl {
      url = "https://github.com/fcoury/tsql/releases/download/v${version}/tsql-aarch64-apple-darwin.tar.gz";
      hash = "sha256-DumyrDn8KMisE9/kGc5Lh2raEc8mkd1QViSwj5Iy3Cg=";
    };

    dontUnpack = true;
    dontStrip = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      tar -xzf $src -C $out/bin tsql
      chmod 755 $out/bin/tsql
      runHook postInstall
    '';

    meta = {
      description = "Keyboard-first PostgreSQL and MongoDB terminal client";
      homepage = "https://github.com/fcoury/tsql";
      license = pkgs.lib.licenses.mit;
      mainProgram = "tsql";
      platforms = [ "aarch64-darwin" ];
    };
  };
in
{
  home.packages = [ tsql ];
}
