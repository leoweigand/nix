{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.homelab.infra.now;
  domain = "now.${config.homelab.baseDomain}";
  package = pkgs.callPackage ../../packages/now { };
  celld = pkgs.callPackage ../../packages/now/celld.nix { };
  node = "${package.nodejs}/bin/node";
  source = "${package}/lib/leolab-now";
  state = "/var/lib/leolab-now";
  store = "/var/lib/leolab-now-store";
  keys = "/var/lib/leolab-now-keys";
  builder = pkgs.callPackage ../../packages/now/builder-sandbox.nix { inherit package; };
  policy = pkgs.writeText "now.json" (
    builtins.toJSON {
      inherit domain;
      issuer = config.homelab.infra.oauth2Proxy.issuerUrl;
      stateDir = state;
      scratchDir = "/run/leolab-now/builds";
      port = cfg.port;
      socket = "/run/leolab-now/frontend.sock";
      runtimeUrl = "http://127.0.0.1:${toString cfg.runtimePort}";
      npm = "${package.nodejs}/bin/npm";
      sandbox = toString builder.install;
      compileSandbox = toString builder.compile;
    }
  );
  hardening = {
    NoNewPrivileges = true;
    PrivateTmp = true;
    PrivateDevices = true;
    ProtectSystem = "strict";
    ProtectHome = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectControlGroups = true;
    RestrictSUIDSGID = true;
    RestrictRealtime = true;
    CapabilityBoundingSet = "";
    RestrictAddressFamilies = [
      "AF_INET"
      "AF_INET6"
      "AF_UNIX"
    ];
    UMask = "0077";
    Restart = "on-failure";
    RestartSec = "3s";
    TasksMax = 128;
  };
in
{
  options.homelab.infra.now = {
    enable = lib.mkEnableOption "shared authenticated Now app publishing";
    port = lib.mkOption {
      type = lib.types.port;
      default = 9092;
    };
    runtimePort = lib.mkOption {
      type = lib.types.port;
      default = 9093;
    };
    storagePort = lib.mkOption {
      type = lib.types.port;
      default = 8333;
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion =
          config.homelab.infra.edge.enable
          && config.homelab.infra.oauth2Proxy.enable
          && config.homelab.infra.mcp.enable;
        message = "Now requires the HTTPS edge, Pocket ID gateway and existing lab MCP";
      }
      {
        assertion = config.homelab.infra.mcp.issuer == config.homelab.infra.oauth2Proxy.issuerUrl;
        message = "Now browser and MCP identities must use the same OIDC issuer";
      }
    ];
    users.groups.leolab-now = { };
    users.users.leolab-now = {
      isSystemUser = true;
      group = "leolab-now";
    };
    systemd.services.leolab-now-keys = {
      description = "Initialise private Now service credentials";
      before = [
        "leolab-now.service"
        "leolab-now-runtime.service"
        "leolab-now-store.service"
        "leolab-mcp.service"
      ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        StateDirectory = "leolab-now-keys";
        StateDirectoryMode = "0700";
        UMask = "0077";
      };
      script = ''
        ${pkgs.python3}/bin/python3 - <<'PY'
        import json, pathlib, secrets
        root = pathlib.Path("${keys}")
        for name in ("control-token", "runtime-token", "s3-key", "s3-secret"):
            if not (root / name).exists():
                with (root / name).open("x") as f: f.write(secrets.token_hex(32))
        key, secret = (root / "s3-key").read_text(), (root / "s3-secret").read_text()
        (root / "storage.json").write_text(json.dumps({"identities":[{"name":"now-runtime","credentials":[{"accessKey":key,"secretKey":secret}],"actions":["Admin","Read","Write","List","Tagging"]}]}))
        (root / "storage.env").write_text(f"AWS_ACCESS_KEY_ID={key}\nAWS_SECRET_ACCESS_KEY={secret}\n")
        PY
      '';
    };
    systemd.services.leolab-now-store = {
      description = "Now private object storage";
      wantedBy = [ "multi-user.target" ];
      requires = [ "leolab-now-keys.service" ];
      after = [ "leolab-now-keys.service" ];
      serviceConfig = hardening // {
        User = "leolab-now";
        Group = "leolab-now";
        StateDirectory = "leolab-now-store";
        StateDirectoryMode = "0700";
        LoadCredential = [ "storage.json:${keys}/storage.json" ];
        ExecStart = "${pkgs.seaweedfs}/bin/weed mini -dir=${store} -ip=127.0.0.1 -ip.bind=127.0.0.1 -bucket=now -s3.port=${toString cfg.storagePort} -s3.config=%d/storage.json -webdav=false -admin.ui=false -master.telemetry=false -s3.port.iceberg=0 -s3.port.lance=0 -volume.max=4 -master.volumeSizeLimitMB=128";
        MemoryMax = "384M";
      };
    };
    systemd.services.leolab-now-runtime = {
      description = "Now shared celld runtime";
      wantedBy = [ "multi-user.target" ];
      requires = [
        "leolab-now-keys.service"
        "leolab-now-store.service"
      ];
      after = [
        "leolab-now-keys.service"
        "leolab-now-store.service"
      ];
      path = [ pkgs.esbuild ];
      environment = {
        CELLD_WATCH = "/var/lib/leolab-now-runtime";
        CELLD_NODE = "picard-now";
        CELLD_IDLE_EVICT_S = "60";
        CELLD_MAX_RESIDENT_CELLS = "8";
        CELLD_MAX_RSS_MB = "384";
        CELLD_V8_HEAP_LIMIT_MB = "64";
        CELLD_MAX_DYNAMIC_WORKER_CODE_BYTES = "2097152";
        CELLD_BUCKET = "s3://now";
        S3_ENDPOINT = "http://127.0.0.1:${toString cfg.storagePort}";
        AWS_REGION = "us-east-1";
      };
      preStart = ''
        set -euo pipefail
        export AWS_ACCESS_KEY_ID="$(cat "$CREDENTIALS_DIRECTORY/s3-key")"
        export AWS_SECRET_ACCESS_KEY="$(cat "$CREDENTIALS_DIRECTORY/s3-secret")"
        # Store readiness is not implied by systemd starting its process.
        ready=false
        for attempt in {1..30}; do
          if ${celld}/bin/celld diagnose --json --listen 127.0.0.1:${toString cfg.runtimePort} > /dev/null; then ready=true; break; fi
          sleep 1
        done
        "$ready"
        cp ${source}/runtime/index.js /var/lib/leolab-now-runtime/index.js
        ${pkgs.python3}/bin/python3 - <<'PY'
        import json,os,pathlib
        config=json.loads(pathlib.Path("${source}/runtime/wrangler.json").read_text())
        config["vars"]={"CAPABILITY":pathlib.Path(os.environ["CREDENTIALS_DIRECTORY"],"runtime-token").read_text().strip()}
        pathlib.Path("/var/lib/leolab-now-runtime/wrangler.json").write_text(json.dumps(config))
        PY
        ${celld}/bin/celld deploy /var/lib/leolab-now-runtime --json
      '';
      script = ''
        export AWS_ACCESS_KEY_ID="$(cat "$CREDENTIALS_DIRECTORY/s3-key")"
        export AWS_SECRET_ACCESS_KEY="$(cat "$CREDENTIALS_DIRECTORY/s3-secret")"
        exec ${celld}/bin/celld --listen 127.0.0.1:${toString cfg.runtimePort} --internal-listen 127.0.0.1:9094
      '';
      serviceConfig = hardening // {
        User = "leolab-now";
        Group = "leolab-now";
        StateDirectory = "leolab-now-runtime";
        StateDirectoryMode = "0700";
        LoadCredential = map (name: "${name}:${keys}/${name}") [
          "s3-key"
          "s3-secret"
          "runtime-token"
        ];
        MemoryMax = "512M";
      };
    };
    systemd.services.leolab-now = {
      description = "Now app registry, builder and authenticated request bridge";
      wantedBy = [ "multi-user.target" ];
      requires = [
        "leolab-now-keys.service"
        "leolab-now-runtime.service"
      ];
      after = [
        "leolab-now-keys.service"
        "leolab-now-runtime.service"
      ];
      environment = {
        NOW_CONFIG = toString policy;
        ESBUILD_BINARY_PATH = "${pkgs.esbuild}/bin/esbuild";
        SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
      };
      path = [ package.nodejs ];
      serviceConfig = hardening // {
        User = "leolab-now";
        Group = config.services.caddy.group;
        StateDirectory = "leolab-now";
        StateDirectoryMode = "0700";
        RuntimeDirectory = "leolab-now";
        RuntimeDirectoryMode = "0750";
        # Bound dependency downloads without allowing a build to fill root disk.
        TemporaryFileSystem = "/run/leolab-now/builds:rw,size=256M,mode=1777";
        LoadCredential = [
          "runtime-token:${keys}/runtime-token"
          "control-token:${keys}/control-token"
        ];
        ExecStart = "${node} ${source}/src/main.ts";
        MemoryMax = "512M";
        TimeoutStopSec = "150s";
      };
    };
    homelab.infra.edge.proxies."*.now" = {
      upstream = "unix//run/leolab-now/frontend.sock";
      auth.passSubject = true;
    };
    security.acme.certs.${config.homelab.baseDomain}.extraDomainNames = [ "*.${domain}" ];
    systemd.services.leolab-mcp = {
      requires = [ "leolab-now-keys.service" ];
      after = [ "leolab-now-keys.service" ];
      serviceConfig.LoadCredential = [ "now-token:${keys}/control-token" ];
    };
    homelab.infra.backup.jobs = lib.mkIf config.homelab.infra.backup.enable {
      now = {
        schedule = "*-*-* 04:40:00";
        paths = [ "/var/lib/leolab-now-backup" ];
        pruneOpts = [
          "--keep-daily 7"
          "--keep-weekly 4"
          "--keep-monthly 3"
        ];
        # Quiesce briefly for a coherent registry + object-store snapshot. The
        # upload reads staging after services resume, not mutable live files.
        prepareCommand = ''
          set -euo pipefail
          resume() { ${pkgs.systemd}/bin/systemctl start leolab-now-store leolab-now-runtime leolab-now; }
          trap resume EXIT
          ${pkgs.systemd}/bin/systemctl stop leolab-now leolab-now-runtime
          ${pkgs.systemd}/bin/systemctl stop leolab-now-store
          install -d -m 0700 /var/lib/leolab-now-backup
          ${pkgs.rsync}/bin/rsync -a --delete --exclude=builds ${state} ${store} ${keys} /var/lib/leolab-now-backup/
          resume
          trap - EXIT
        '';
      };
    };
    services.restic.backups = lib.mkIf config.homelab.infra.backup.enable {
      now.backupCleanupCommand = ''
        ${pkgs.systemd}/bin/systemctl start leolab-now-store leolab-now-runtime leolab-now
      '';
    };
  };
}
