{ pkgs, ... }:

let
  version = "20261025.114930.0-sha.b4dd513d";
  swamp = pkgs.stdenvNoCC.mkDerivation {
    pname = "swamp";
    inherit version;

    src = pkgs.fetchurl {
      url = "https://artifacts.swamp-club.com/swamp/${version}/binary/darwin/aarch64/swamp-${version}-binary-darwin-aarch64.tar.gz";
      hash = "sha256-zZTe7vGJ5SEET/628g857YBLBUQ7nqOVWLBj9GQCIus=";
    };

    dontUnpack = true;
    # Preserve the upstream Deno executable and its embedded application.
    dontStrip = true;
    installPhase = ''
      runHook preInstall
      mkdir -p $out/bin
      tar -xzf $src -C $out/bin swamp
      chmod 755 $out/bin/swamp
      runHook postInstall
    '';

    meta = {
      description = "Repeatable automation for AI agents";
      homepage = "https://swamp-club.com";
      license = pkgs.lib.licenses.agpl3Only;
      mainProgram = "swamp";
      platforms = [ "aarch64-darwin" ];
    };
  };
in
{
  home.packages = [ swamp ];
}
