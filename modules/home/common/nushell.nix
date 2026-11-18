{
  config,
  lib,
  ...
}:

{
  programs.nushell = {
    enable = true;
    loadSessionVariables = true;

    settings = {
      show_banner = false;
      edit_mode = "emacs";
    };

    shellAliases = {
      f = "fzf";
      gp = "git pull";
      gs = "git status";
      l = "ls -l";
      la = "ls -la";
    };
  };

  # Keep SSH commands and tools that invoke $SHELL -c on Zsh syntax.
  programs.zsh.initContent = lib.mkOrder 2000 ''
    if [[ -o interactive && -t 0 && ! -v ZSH_EXECUTION_STRING && -z "''${KEEP_ZSH-}" && $# -eq 0 ]]; then
      if [[ -o login ]]; then
        exec ${lib.getExe config.programs.nushell.package} --login
      else
        exec ${lib.getExe config.programs.nushell.package}
      fi
    fi
  '';
}
