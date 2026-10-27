{ lib, pkgs, ... }:

let
  usage4claude = pkgs.stdenvNoCC.mkDerivation rec {
    pname = "usage4claude";
    version = "3.5.0";

    src = pkgs.fetchurl {
      url = "https://github.com/f-is-h/Usage4Claude/releases/download/v${version}/Usage4Claude-v${version}.dmg";
      hash = "sha256-7cRjyGFaAnuOZPpzAQzXUsbRDnXhFPJxL40ZtgJ0TCc=";
    };

    dontUnpack = true;
    # Preserve the upstream app signature.
    dontFixup = true;

    installPhase = ''
      runHook preInstall
      mountPoint="$TMPDIR/usage4claude"
      mkdir -p "$mountPoint"
      /usr/bin/hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mountPoint" "$src"
      trap '/usr/bin/hdiutil detach -quiet "$mountPoint"' EXIT
      mkdir -p "$out/Applications"
      cp -R "$mountPoint/Usage4Claude.app" "$out/Applications/"
      runHook postInstall
    '';

    meta = {
      description = "Claude and Codex usage monitor for the macOS menu bar";
      homepage = "https://github.com/f-is-h/Usage4Claude";
      license = lib.licenses.mit;
      platforms = [ "aarch64-darwin" ];
    };
  };
in
{
  environment.systemPackages = [ usage4claude ];

  system.activationScripts.applications.text = lib.mkAfter ''
    if [ ! -e /Applications/Usage4Claude.app ] || [ -L /Applications/Usage4Claude.app ]; then
      ln -sfn 'Nix Apps/Usage4Claude.app' /Applications/Usage4Claude.app
    fi
  '';
}
