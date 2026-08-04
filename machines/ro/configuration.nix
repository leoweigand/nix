{ ... }:

{
  imports = [ ../../modules/darwin/common.nix ];

  home-manager.users.leo.imports = [ ../../modules/home/darwin/personal.nix ];

  homebrew = {
    enable = true;
    enableZshIntegration = true;
    onActivation = {
      autoUpdate = true;
      upgrade = true;
      cleanup = "zap";
    };
    brews = [
      # keeping in brew, not migrating to nix
      "cocoapods"
      "deno"
    ];
    casks = [
      "blender"
      "cmux"
      "codex"
      "font-ia-writer-quattro"
      "ghostty"
      "macwhisper"
      "obsidian"
      "raycast"
      "tailscale-app"
      "zed"
    ];
  };

  system.stateVersion = 5;
}
