{
  lib,
  buildNpmPackage,
  nodejs_26,
}:
buildNpmPackage {
  pname = "leolab-assistant";
  version = "1.1.0";
  nodejs = nodejs_26;
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./package.json
      ./package-lock.json
      ./tsconfig.json
      ./src
      ./agent
      ./instructions
      ./skills
      ./scripts
      ./patches
    ];
  };
  npmDepsHash = "sha256-JzH76vLJU6BsSmS3X6fRy5r8KwGcyQO2UjmjsNhl16Q=";
  npmFlags = [ "--ignore-scripts" ];
  buildPhase = ''
    runHook preBuild
    npm run build
    runHook postBuild
  '';
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npx --no-install tsc --noEmit
    node --test src/*_test.ts
    npx --no-install prettier --check src agent scripts patches package.json tsconfig.json
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts
    mkdir -p "$out/lib/leolab-assistant"
    cp -r src agent instructions skills scripts patches node_modules package.json "$out/lib/leolab-assistant/"
    cp -rL .output "$out/lib/leolab-assistant/.output"
    runHook postInstall
  '';
  passthru.nodejs = nodejs_26;
}
