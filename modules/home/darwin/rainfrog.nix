{ pkgs, ... }:

let
  rainfrog-prod = pkgs.writeShellApplication {
    name = "rainfrog-prod";
    runtimeInputs = [ pkgs._1password-cli pkgs.rainfrog ];
    text = ''
      # Resolve at launch so the credential stays out of the Nix store and argv.
      DATABASE_URL="$(op read --account elephantcompany.1password.com 'op://Engineering/Production Postgres Read-Only Role/Connection string')"
      export DATABASE_URL
      exec rainfrog "$@"
    '';
  };
in
{
  home.packages = [ pkgs.rainfrog rainfrog-prod ];
}
