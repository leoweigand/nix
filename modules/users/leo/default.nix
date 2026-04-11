{ ... }:

{
  home-manager.useGlobalPkgs = true;    # reuse system nixpkgs (one eval, consistent versions)
  home-manager.useUserPackages = true;  # install HM packages into /etc/profiles/per-user/leo

  users.groups.nixconfig = { };  # shared nix config repo access at /opt/nixos-config

  users.users.leo = {
    isNormalUser = true;
    extraGroups = [
      "wheel"      # sudo access
      "nixconfig"  # read/write /opt/nixos-config
    ];
    linger = true;  # start user@1000.service at boot (needed for rootless podman socket without active login)
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDevMcuw1B5G4A3K2RbCgA9rz43bG4Imz2nKm9K3X8lL "
    ];
  };

  home-manager.users.leo = {
    imports = [ ../../home ];
  };
}
