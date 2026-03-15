{ ... }:

{
  imports = [
    ./1password.nix
    ./auth.nix
    ./authentik.nix
    ./backup.nix
    ./edge-dns.nix
    ./mqtt.nix
    ./reverse-proxy.nix
    ./tailscale.nix
  ];
}
