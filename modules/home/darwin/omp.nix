{ pkgs, ... }:

let
  version = "18.2.8";
  omp = pkgs.stdenvNoCC.mkDerivation {
    pname = "omp";
    inherit version;

    src = pkgs.fetchurl {
      url = "https://github.com/can1357/oh-my-pi/releases/download/v${version}/omp-darwin-arm64";
      hash = "sha256-z400p/5vYN4ay+dPKcggJuTAeIjp2J9+vO65IhWeV4c=";
    };

    dontUnpack = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      install -m755 $src $out/bin/omp
      runHook postInstall
    '';

    meta = {
      description = "Terminal coding agent for the Pi ecosystem";
      homepage = "https://omp.sh";
      license = pkgs.lib.licenses.mit;
      mainProgram = "omp";
      platforms = [ "aarch64-darwin" ];
    };
  };
in
{
  home.packages = [ omp ];
}
