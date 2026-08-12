{ lib, ... }:

{
  imports = [ ../../modules/darwin/common.nix ];

  home-manager.users.leo.imports = [ ../../modules/home/darwin/claude-code.nix ];

  home-manager.users.leo.home.sessionPath = [ "$HOME/Library/pnpm/bin" ];
  home-manager.users.leo.programs.zsh.initContent = lib.mkAfter ''
    export NVM_DIR="$HOME/.nvm"
    [ -s "/opt/homebrew/opt/nvm/nvm.sh" ] && . "/opt/homebrew/opt/nvm/nvm.sh"
  '';

  home-manager.users.leo.programs.ssh = {
    enable = true;
    matchBlocks."github.com" = {
      # macOS's built-in agent exits without responding, hanging GitHub SSH.
      identityFile = "~/.ssh/id_ed25519";
      identitiesOnly = true;
      extraOptions.IdentityAgent = "none";
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
