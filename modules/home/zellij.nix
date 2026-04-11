{ ... }:

{
  programs.zellij = {
    enable = true;

    settings = {
      # Use simplified UI: no pane frames, just the status bar
      simplified_ui = true;
      # Avoid auto-attaching on shell start; launch zellij explicitly
      # (shell integration is not enabled here — zsh is still managed by chezmoi)
    };
  };
}
