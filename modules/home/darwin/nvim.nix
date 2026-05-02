{ config, ... }:

{
  # mkOutOfStoreSymlink keeps the directory writable so lazy.nvim can update its lockfile
  xdg.configFile."nvim".source =
    config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/git/nix/modules/home/darwin/nvim";
}
