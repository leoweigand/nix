{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  zlib,
  openssl,
}:
stdenv.mkDerivation {
  pname = "celld";
  version = "0.6.3";
  src = fetchurl {
    url = "https://github.com/denoland/celld/releases/download/v0.6.3/celld-x86_64-unknown-linux-gnu.gz";
    hash = "sha256-UISgg0cs8DZVGn6sY/ok0iu5pWMjxRf2MgVyTBJ4MEc=";
  };
  nativeBuildInputs = [ autoPatchelfHook ];
  buildInputs = [
    stdenv.cc.cc.lib
    zlib
    openssl
  ];
  dontUnpack = true;
  installPhase = ''
    mkdir -p "$out/bin"
    gzip -dc "$src" > "$out/bin/celld"
    chmod +x "$out/bin/celld"
  '';
  meta = {
    platforms = [ "x86_64-linux" ];
    license = lib.licenses.asl20;
  };
}
