{ pkgs, ... }:

let
  version = "0.9.0";
  herdr = pkgs.stdenvNoCC.mkDerivation {
    pname = "herdr";
    inherit version;

    src = pkgs.fetchurl {
      url = "https://github.com/herdrdev/herdr/releases/download/v${version}/herdr-macos-aarch64";
      hash = "sha256-MrU98JhyYoBZx4mmnwKmuOKeFN3yZxFCHzRj9wwa7xc=";
    };

    dontUnpack = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      install -m755 $src $out/bin/herdr
      runHook postInstall
    '';

    meta = {
      description = "Terminal workspace manager for AI coding agents";
      homepage = "https://herdr.dev";
      license = pkgs.lib.licenses.asl20;
      mainProgram = "herdr";
      platforms = [ "aarch64-darwin" ];
    };
  };
in
{
  home.packages = [ herdr ];
}
