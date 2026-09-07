{ ... }:

{
  programs.opencode = {
    enable = true;
    settings = {
      autoupdate = false;

      # Declared here so it survives Home Manager rewriting opencode.json.
      # OAuth credentials live in ~/.config/opencode/mcp-auth.json, not here.
      mcp.linear = {
        type = "remote";
        url = "https://mcp.linear.app/mcp";
        enabled = true;
      };
    };
  };
}
