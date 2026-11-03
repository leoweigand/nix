{ pkgs, package }:
let
  celld = pkgs.callPackage ../packages/now/celld.nix { };
  builder = pkgs.callPackage ../packages/now/builder-sandbox.nix { inherit package; };
in
pkgs.runCommand "now-runtime-check"
  {
    nativeBuildInputs = [
      package.nodejs
      pkgs.seaweedfs
      pkgs.esbuild
      pkgs.python3
    ];
  }
  ''
    set -euo pipefail
    export HOME="$TMPDIR"
    mkdir store runtime bootstrap recovery
    cat > storage.json <<'JSON'
    {"identities":[{"name":"fixture","credentials":[{"accessKey":"fixture","secretKey":"fixture-secret"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
    JSON
    start_store() {
      weed mini -dir="$PWD/store" -ip=127.0.0.1 -ip.bind=127.0.0.1 -bucket=now \
      -s3.port=18333 -s3.config="$PWD/storage.json" -master.port=19333 -master.port.grpc=29333 \
      -filer.port=18888 -filer.port.grpc=28888 -volume.port=19340 -volume.port.grpc=29340 \
      -webdav=false -admin.ui=false -master.telemetry=false -s3.port.iceberg=0 -s3.port.lance=0 \
      -volume.max=2 -master.volumeSizeLimitMB=64 > weed.log 2>&1 &
      store_pid=$!
    }
    start_store
    runtime_pid=""
    cleanup() { [[ -z "$runtime_pid" ]] || kill "$runtime_pid" || true; kill "$store_pid" || true; }
    trap cleanup EXIT
    export AWS_ACCESS_KEY_ID=fixture AWS_SECRET_ACCESS_KEY=fixture-secret AWS_REGION=us-east-1
    export CELLD_BUCKET=s3://now S3_ENDPOINT=http://127.0.0.1:18333
    export CELLD_WATCH="$PWD/runtime" CELLD_NODE=fixture CELLD_IDLE_EVICT_S=2
    export ESBUILD_BINARY_PATH=${pkgs.esbuild}/bin/esbuild
    export NOW_TEST_COMPILE_SANDBOX=${builder.compile}
    ready=false
    for attempt in {1..60}; do
      if ${celld}/bin/celld diagnose --listen 127.0.0.1:18970 > diagnose.log 2>&1; then ready=true; break; fi
      sleep 0.2
    done
    if ! "$ready"; then cat diagnose.log weed.log; exit 1; fi
    cp ${package}/lib/leolab-now/runtime/index.js bootstrap/index.js
    python3 - <<'PY'
    import json,pathlib
    c=json.loads(pathlib.Path("${package}/lib/leolab-now/runtime/wrangler.json").read_text())
    c["vars"]={"CAPABILITY":"fixture-only"}
    pathlib.Path("bootstrap/wrangler.json").write_text(json.dumps(c))
    PY
    ${celld}/bin/celld deploy bootstrap --json
    start_runtime() {
      ${celld}/bin/celld --listen 127.0.0.1:18970 --internal-listen 127.0.0.1:18971 > celld.log 2>&1 &
      runtime_pid=$!
      python3 - <<'PY'
    import time,urllib.request,urllib.error
    for attempt in range(100):
        try: urllib.request.urlopen('http://127.0.0.1:18970')
        except urllib.error.HTTPError as e:
            if e.code==401: break
        except OSError: pass
        time.sleep(0.1)
    else: raise RuntimeError('Runtime did not start')
    PY
    }
    start_runtime
    export NOW_TEST_RUNTIME_URL=http://127.0.0.1:18970 NOW_TEST_RUNTIME_TOKEN=fixture-only NOW_TEST_IDLE_WAIT_MS=3500
    node --test ${package}/lib/leolab-now/src/runtime_test.ts || { cat celld.log weed.log; exit 1; }
    export NOW_RECOVERY_DIR="$PWD/recovery"
    node ${package}/lib/leolab-now/src/recovery-fixture.ts seed
    kill -KILL "$runtime_pid"
    wait "$runtime_pid" || true
    start_runtime
    node ${package}/lib/leolab-now/src/recovery-fixture.ts verify
    kill "$runtime_pid"
    wait "$runtime_pid"
    runtime_pid=""
    kill "$store_pid"
    wait "$store_pid"
    # Take a coherent cold backup, then restore into fresh directories without
    # celld's local cache. Remote object storage must reconstruct the saved app.
    mkdir snapshot
    cp -a store recovery snapshot/
    rm -rf store recovery runtime
    cp -a snapshot/store snapshot/recovery .
    mkdir runtime
    start_store
    # Diagnose also waits for the restored S3 endpoint to become ready.
    ready=false
    for attempt in {1..60}; do
      if ${celld}/bin/celld diagnose --listen 127.0.0.1:18970 > diagnose.log 2>&1; then ready=true; break; fi
      sleep 0.2
    done
    "$ready"
    start_runtime
    node ${package}/lib/leolab-now/src/recovery-fixture.ts destroy
    touch "$out"
  ''
