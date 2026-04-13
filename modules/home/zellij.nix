{ ... }:

{
  programs.zellij = {
    enable = true;

    settings = {
      # Use simplified UI: no pane frames, just the status bar
      simplified_ui = true;
      show_startup_tips = false;
      # Require unlocking before sending key bindings to zellij; avoids key conflicts with apps inside
      default_mode = "locked";
      # Avoid auto-attaching on shell start; launch zellij explicitly
      # (shell integration is not enabled here — zsh is still managed by chezmoi)
    };
  };
}
