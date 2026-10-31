{
  lib,
  stdenvNoCC,
  fetchurl,
}:

stdenvNoCC.mkDerivation {
  pname = "rex-desktop";
  version = "0.1.0-1642";

  # Pin the installed preview from the app's upstream Sparkle feed.
  src = fetchurl {
    url = "https://blob.superlogical.com/public/rex-app/preview/Rex-0.1.0-1642.dmg";
    hash = "sha256-f3aeknznWKXtlmX8pIrptiXeJXHhlRpQWQvOUkXx414=";
  };

  dontUnpack = true;
  # Preserve the upstream app bundle and its code signature.
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    mountPoint="$TMPDIR/rex-desktop"
    mkdir -p "$mountPoint"
    /usr/bin/hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mountPoint" "$src"
    trap '/usr/bin/hdiutil detach -quiet "$mountPoint"' EXIT
    mkdir -p "$out/Applications"
    cp -R "$mountPoint/Rex Beta.app" "$out/Applications/"
    runHook postInstall
  '';

  meta = {
    description = "Rex desktop preview";
    license = lib.licenses.unfree;
    platforms = [ "aarch64-darwin" ];
  };
}
