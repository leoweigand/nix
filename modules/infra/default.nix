{ ... }:

{
  imports = [
    ./1password.nix
    ./backup.nix
    ./cloudflare-tunnel.nix
    ./edge-dns.nix
    ./homepage.nix
    ./mqtt.nix
    ./notification-gateway.nix
    ./oauth2-proxy.nix
    ./pocket-id.nix
    ./reverse-proxy.nix
    ./tailscale.nix
    ./tinyauth.nix
  ];
}
