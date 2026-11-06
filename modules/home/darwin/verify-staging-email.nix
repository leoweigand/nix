{ pkgs, ... }:

{
  home.packages = [
    (pkgs.writeShellApplication {
      name = "verify-staging-email";
      # Use the caller's configured op CLI rather than shadowing it with another version.
      runtimeInputs = [ pkgs.nodejs_26 pkgs.postgresql ];
      text = ''
        exec node ${../../../packages/verify-staging-email/main.ts} "$@"
      '';
    })
  ];
}
