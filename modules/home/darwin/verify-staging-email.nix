{ pkgs, ... }:

{
  home.packages = [
    (pkgs.writeShellApplication {
      name = "verify-staging-email";
      runtimeInputs = [ pkgs.nodejs_26 pkgs._1password-cli pkgs.postgresql ];
      text = ''
        exec node ${../../../packages/verify-staging-email/main.ts} "$@"
      '';
    })
  ];
}
