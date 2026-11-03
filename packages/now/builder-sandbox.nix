{
  writeShellScript,
  callPackage,
  package,
}:
let
  sandbox = callPackage ../automation/sandbox.nix { };
  node = "${package.nodejs}/bin/node";
  source = "${package}/lib/leolab-now";
in
{
  install = writeShellScript "now-dependencies" ''
    set -euo pipefail
    directory="$1"
    shift
    exec ${sandbox}/bin/landrun --rox /nix/store --ro /etc/resolv.conf \
      --ro /etc/nsswitch.conf --ro /etc/hosts --ro /dev/urandom --ro /dev/null \
      --rw "$directory" --connect-tcp 443 \
      --env PATH --env HOME --env npm_config_cache --env npm_config_userconfig \
      --env npm_config_globalconfig --env SSL_CERT_FILE -- "$@"
  '';
  compile = writeShellScript "now-compile" ''
    set -euo pipefail
    directory="$1"
    exec ${sandbox}/bin/landrun --rox /nix/store --ro /dev/urandom --ro /dev/null \
      --ro /proc/self --ro /proc/meminfo --ro /proc/cpuinfo \
      --rw "$directory" --connect-tcp 1 --env ESBUILD_BINARY_PATH -- \
      ${node} ${source}/src/builder.ts --compile "$directory"
  '';
}
