{
  lib,
  buildNpmPackage,
  nodejs_26,
  esbuild,
  buildGoModule,
  fetchFromGitHub,
}:
let
  # The npm API and native executable must have the same version.
  esbuildRuntime = esbuild.override {
    buildGoModule =
      args:
      buildGoModule (
        args
        // rec {
          version = "0.28.2";
          src = fetchFromGitHub {
            owner = "evanw";
            repo = "esbuild";
            tag = "v${version}";
            hash = "sha256-I1u+9U5Oj/KzxSjCxwyitwSuDKimatkbC3R2OtaUsfM=";
          };
          vendorHash = "sha256-+BfxCyg0KkDQpHt/wycy/8CTG6YBA/VJvJFhhzUnSiQ=";
        }
      );
  };
in
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
  npmDepsHash = "sha256-jQf9OjikAnXb5cxJFdFNI0DQ71KYiecTPpEyoKj3als=";
  npmFlags = [ "--ignore-scripts" ];
  dontNpmBuild = true;
  ESBUILD_BINARY_PATH = "${esbuildRuntime}/bin/esbuild";
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
  passthru = {
    nodejs = nodejs_26;
    esbuild = esbuildRuntime;
  };
}
