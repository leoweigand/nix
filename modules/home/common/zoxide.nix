{ ... }:

{
  programs.zoxide = {
    enable = true;
    enableNushellIntegration = true;
    enableZshIntegration = true;
    options = [ "--cmd cd" ];  # Replace `cd` with zoxide's smart jump
  };
}
