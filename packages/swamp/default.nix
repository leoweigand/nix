{
  lib,
  stdenvNoCC,
  fetchurl,
  autoPatchelfHook,
  stdenv,
  makeWrapper,
  deno,
}:

stdenvNoCC.mkDerivation rec {
  pname = "swamp";
  version = "20261025.114930.0-sha.b4dd513d";

  src = fetchurl {
    url = "https://artifacts.swamp-club.com/swamp/${version}/binary/linux/x86_64/swamp-${version}-binary-linux-x86_64.tar.gz";
    hash = "sha256-Sw42fIepMk/dWt7sF8V4eYsma+oFsifVYevFf00Eb64=";
  };

  nativeBuildInputs = [
    autoPatchelfHook
    makeWrapper
  ];
  buildInputs = [ stdenv.cc.cc.lib ];
  dontUnpack = true;
  dontStrip = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/bin
    tar -xzf $src -C $out/bin swamp
    chmod 755 $out/bin/swamp
    wrapProgram $out/bin/swamp --prefix PATH : ${lib.makeBinPath [ deno ]}
    runHook postInstall
  '';

  meta = {
    description = "Repeatable automation for AI agents";
    homepage = "https://swamp-club.com";
    license = lib.licenses.agpl3Only;
    mainProgram = "swamp";
    platforms = [ "x86_64-linux" ];
  };
}
