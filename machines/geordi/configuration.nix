{ ... }:

{
  imports = [ ../../modules/darwin/common.nix ];

  home-manager.users.leo.home.sessionPath = [ "$HOME/Library/pnpm/bin" ];

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
    casks = [
      "codex"
      "ghostty"
      "google-drive"
      "macwhisper"
      "obsidian"
      "raycast"
      "zed"
    ];
  };

  system.stateVersion = 5;
}
