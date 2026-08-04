{ ... }:

{
  imports = [ ../../modules/darwin/common.nix ];

  home-manager.users.leo.home.sessionPath = [ "$HOME/Library/pnpm/bin" ];

  homebrew = {
    enable = true;
    enableZshIntegration = true;
    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "zap";
    };
    casks = [
      "codex"
      "ghostty"
      "macwhisper"
      "obsidian"
      "raycast"
      "zed"
    ];
  };

  system.stateVersion = 5;
}
