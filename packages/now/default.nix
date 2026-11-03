{
  lib,
  buildNpmPackage,
  nodejs_26,
  esbuild,
}:
buildNpmPackage {
  pname = "leolab-now";
  version = "0.1.0";
  nodejs = nodejs_26;
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./src
      ./runtime
    ];
  };
  npmDepsHash = "sha256-mfHMLDw174nrwZpBdo2s0KgLfdwEUxCFbFK0kdgP34I=";
  npmFlags = [ "--ignore-scripts" ];
  dontNpmBuild = true;
  ESBUILD_BINARY_PATH = "${esbuild}/bin/esbuild";
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    node --test src/*_test.ts
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/leolab-now"
    cp -r src runtime node_modules package.json "$out/lib/leolab-now/"
    runHook postInstall
  '';
  passthru.nodejs = nodejs_26;
}
