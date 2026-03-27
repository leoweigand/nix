{ ... }:

{
  imports = [
    ./1password.nix
    ./backup.nix
    ./cloudflare-tunnel.nix
    ./edge-dns.nix
    ./mqtt.nix
    ./reverse-proxy.nix
    ./tailscale.nix
    ./tinyauth.nix
  ];
}
