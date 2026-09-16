{ inputs, ... }:

{
  imports = [ inputs.oh-my-pi.homeManagerModules.default ];

  programs.omp.enable = true;
}
