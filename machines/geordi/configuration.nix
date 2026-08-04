{ ... }:

{
  imports = [ ../../modules/darwin/common.nix ];

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
