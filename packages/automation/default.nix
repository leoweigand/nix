{
  lib,
  buildNpmPackage,
  nodejs_26,
}:

buildNpmPackage {
  pname = "homelab-automation";
  version = "1.0.0";
  nodejs = nodejs_26;
  src = lib.fileset.toSource {
    root = ../..;
    fileset = lib.fileset.unions [
      ../../package.json
      ../../package-lock.json
      ../../.npmrc
      ../../tsconfig.json
      ../../.prettierrc.json
      (lib.fileset.fileFilter (file: file.hasExt "ts") ../../modules)
    ];
  };
  npmDepsHash = "sha256-92Pr5T1rFvpvLXyBT4FEHOAB2cjjKjJ7WJLxnZNK8g8=";
  dontNpmBuild = true;
  npmFlags = [ "--ignore-scripts" ];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run check
    npm test
    npm run format:check
    runHook postCheck
  '';
  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts
    mkdir -p "$out/lib/homelab-automation"
    cp -r modules node_modules package.json "$out/lib/homelab-automation/"
    runHook postInstall
  '';
  passthru.nodejs = nodejs_26;
  meta.description = "Homelab TypeScript automation with locked offline dependencies";
}
