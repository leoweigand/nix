{ ... }:

{
  programs.zellij = {
    enable = true;

    settings = {
      # Use simplified UI: no pane frames, just the status bar
      simplified_ui = true;
      show_startup_tips = false;
      # Avoid auto-attaching on shell start; launch zellij explicitly
      # (shell integration is not enabled here — zsh is still managed by chezmoi)
    };
  };
}
