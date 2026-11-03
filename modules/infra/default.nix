{ ... }:

{
  imports = [
    ./1password.nix
    ./assistant
    ./ai-gateway
    ./backup.nix
    ./cloudflare-tunnel.nix
    ./edge-dns.nix
    ./homepage.nix
    ./mcp.nix
    ./mqtt.nix
    ./notification-gateway
    ./now.nix
    ./oauth2-proxy.nix
    ./pocket-id.nix
    ./reverse-proxy.nix
    ./tailscale.nix
  ];
}
