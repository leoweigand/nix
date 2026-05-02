{ hostPlatform, lib, ... }:

{
  # `hostPlatform` ("linux" | "darwin") comes from each machine's
  # `home-manager.extraSpecialArgs`. We avoid `pkgs.stdenv.isLinux` here
  # because referencing `pkgs` from `imports` recurses through
  # `_module.args` when home-manager runs with `useGlobalPkgs = true`.
  imports = [
    ./common
  ]
  ++ lib.optional (hostPlatform == "linux") ./nixos
  ++ lib.optional (hostPlatform == "darwin") ./darwin;
}
