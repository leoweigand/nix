{ ... }:

{
  programs.git = {
    enable = true;
    settings = {
      user.name = "Leo Weigand";
      user.email = "5489276+leoweigand@users.noreply.github.com";
      push.default = "current";
      pull.ff = "only";
      url."git@github.com:".insteadOf = "https://github.com/";
    };
    signing.format = null; # opt into new default (was "openpgp")
  };
}
