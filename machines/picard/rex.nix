{ inputs, ... }:
{
  imports = [ inputs.rex.nixosModules.default ];

  services.rex.loginServer = {
    enable = true;
    accounts.leo.principals = [ "tailscale:leonard.weigand@gmail.com" ];
    # Reuse Picard's Tailscale identity and leave Caddy's HTTPS listener alone.
    extraListen = [ "tailnet://:7297" ];
  };
}
