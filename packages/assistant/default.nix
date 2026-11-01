{
  lib,
  buildNpmPackage,
  nodejs_26,
}:
buildNpmPackage {
  pname = "leolab-assistant";
  version = "1.0.0";
  nodejs = nodejs_26;
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./tsconfig.json
      ./src
    ];
  };
  npmDepsHash = "sha256-EfRItAzlnbY3INx0BBZY8LlleItjhxjmljQ+NPaM+FA=";
  npmFlags = [ "--ignore-scripts" ];
  dontNpmBuild = true;
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npx --no-install tsc --noEmit
    node --test src/*_test.ts
    npx --no-install prettier --check src package.json tsconfig.json
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts
    mkdir -p "$out/lib/leolab-assistant"
    cp -r src node_modules package.json "$out/lib/leolab-assistant/"
    runHook postInstall
  '';
  passthru.nodejs = nodejs_26;
}
