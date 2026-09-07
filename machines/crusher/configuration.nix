{ lib, pkgs, ... }:

{
  imports = [ ../../modules/darwin/common.nix ];

  home-manager.users.leo.imports = [ ../../modules/home/darwin/claude-code.nix ];

  home-manager.users.leo.home.sessionPath = [ "$HOME/Library/pnpm/bin" ];

  # psql (plus pg_dump and friends); nixpkgs has no client-only build, so this is
  # the full server package with everything in its default output.
  home-manager.users.leo.home.packages = [ pkgs.postgresql ];

  home-manager.users.leo.programs.zsh.initContent = lib.mkAfter ''
    export NVM_DIR="$HOME/.nvm"
    [ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"
    # nvm ships bash-style completion; it calls bashcompinit itself, so it has to
    # come after home-manager's compinit (hence mkAfter).
    [ -s "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm" ] && . "/opt/homebrew/opt/nvm/etc/bash_completion.d/nvm"

    # Equivalent of fnm's --use-on-cd: pick up .nvmrc on every directory change.
    autoload -U add-zsh-hook
    load-nvmrc() {
      local nvmrc_path="$(nvm_find_nvmrc)"
      if [ -n "$nvmrc_path" ]; then
        local wanted="$(nvm version "$(cat "$nvmrc_path")")"
        if [ "$wanted" = "N/A" ]; then
          nvm install
        elif [ "$wanted" != "$(nvm version)" ]; then
          nvm use >/dev/null
        fi
      # Left a directory tree that had a .nvmrc, so drop back to the default
      elif [ -n "$(PWD=$OLDPWD nvm_find_nvmrc)" ] && [ "$(nvm version)" != "$(nvm version default)" ]; then
        nvm use default >/dev/null
      fi
    }
    add-zsh-hook chpwd load-nvmrc
    load-nvmrc
  '';

  home-manager.users.leo.programs.ssh = {
    enable = true;
    # Skip home-manager's legacy `Host *` block; its values all match OpenSSH's
    # own defaults
    enableDefaultConfig = false;
    # Keys are upstream ssh_config directive names
    settings."github.com" = {
      IdentityFile = "~/.ssh/id_ed25519";
      IdentitiesOnly = true;
    };
  };

  homebrew = {
    enable = true;
    enableZshIntegration = true;
    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "zap";
    };
    brews = [ "nvm" ];
    casks = [
      "codex"
      "ghostty"
      "google-drive"
      "macwhisper"
      "obsidian"
      "raycast"
      "tailscale-app"
      "zed"
    ];
  };

  system.stateVersion = 5;
}
