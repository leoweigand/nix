{ ... }:

{
  imports = [
    ./1password.nix
    ./backup.nix
    ./edge-dns.nix
    ./mqtt.nix
    ./reverse-proxy.nix
    ./tailscale.nix
    ./tinyauth.nix
  ];
}
