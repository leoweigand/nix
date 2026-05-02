{ ... }:

{
  programs.zoxide = {
    enable = true;
    enableZshIntegration = true;
    options = [ "--cmd cd" ];  # Replace `cd` with zoxide's smart jump
  };
}
