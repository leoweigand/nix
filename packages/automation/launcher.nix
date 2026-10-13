{
  lib,
  writeShellApplication,
  cacert,
  callPackage,
}:

{
  name,
  script,
  readPaths ? [ ],
  writePaths ? [ ],
  credentialNames ? [ ],
  environmentNames ? [ ],
  connectPorts ? [ 443 ],
  bindPorts ? [ ],
}:
let
  automation = callPackage ./default.nix { };
  sandbox = callPackage ./sandbox.nix { };
  flag = name: value: "${name} ${lib.escapeShellArg (toString value)}";
in
writeShellApplication {
  inherit name;
  text = ''
    # Landlock also constrains SQLite and children, without changing the worker's namespaces.
    policy=(
      --rox /nix/store --ro /etc/resolv.conf --ro /etc/nsswitch.conf
      --ro /etc/hosts --ro /dev/urandom --ro /proc/self --ro /proc/meminfo --ro /proc/cpuinfo
      --env SSL_CERT_FILE=${cacert}/etc/ssl/certs/ca-bundle.crt
      ${lib.concatMapStringsSep "\n" (flag "--ro") readPaths}
      ${lib.concatMapStringsSep "\n" (flag "--rw") writePaths}
      ${lib.concatMapStringsSep "\n" (flag "--env") environmentNames}
      ${lib.concatMapStringsSep "\n" (flag "--connect-tcp") connectPorts}
      ${lib.concatMapStringsSep "\n" (flag "--bind-tcp") bindPorts}
    )
    ${lib.concatMapStringsSep "\n" (credential: ''
      policy+=(--ro "''${CREDENTIALS_DIRECTORY:?}/${credential}")
    '') credentialNames}
    exec ${sandbox}/bin/landrun "''${policy[@]}" -- \
      ${automation.nodejs}/bin/node \
      ${automation}/lib/homelab-automation/${script} "$@"
  '';
}
