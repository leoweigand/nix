{ ... }:

{
  imports = [
    ./1password.nix
    ./ai-gateway
    ./backup.nix
    ./cloudflare-tunnel.nix
    ./edge-dns.nix
    ./homepage.nix
    ./mqtt.nix
    ./notification-gateway
    ./oauth2-proxy.nix
    ./pocket-id.nix
    ./reverse-proxy.nix
    ./tailscale.nix
  ];
}
