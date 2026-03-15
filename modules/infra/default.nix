{ ... }:

{
  imports = [
    ./1password.nix
    ./auth.nix
    ./backup.nix
    ./edge-dns.nix
    ./mqtt.nix
    ./reverse-proxy.nix
    ./tailscale.nix
  ];
}
