{ pkgs, ... }:

let
  # nixpkgs omits sqlite, but sqlx-macros links -lsqlite3 on Darwin.
  rainfrog = pkgs.rainfrog.overrideAttrs (old: {
    buildInputs = (old.buildInputs or [ ]) ++ [ pkgs.sqlite ];
  });

  rainfrog-prod = pkgs.writeShellApplication {
    name = "rainfrog-prod";
    runtimeInputs = [ pkgs._1password-cli rainfrog ];
    text = ''
      # Resolve at launch so the credential stays out of the Nix store and argv.
      DATABASE_URL="$(op read --account elephantcompany.1password.com 'op://Engineering/Production Postgres Read-Only Role/Connection string')"
      export DATABASE_URL
      exec rainfrog "$@"
    '';
  };
in
{
  home.packages = [ rainfrog rainfrog-prod ];
}
