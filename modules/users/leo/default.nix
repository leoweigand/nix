{ pkgs, ... }:

{
  users.groups.nixconfig = { };  # shared nix config repo access at /opt/nixos-config
  users.groups.homelab = { };    # read access to per-service data dirs under /mnt/fast/*

  users.users.leo = {
    isNormalUser = true;
    shell = pkgs.zsh;
    extraGroups = [
      "wheel"      # sudo access
      "nixconfig"  # read/write /opt/nixos-config
      "homelab"    # read /mnt/fast/* data dirs (paperless, immich, notes, ...)
    ];
    linger = true;  # start user@1000.service at boot (needed for rootless podman socket without active login)
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDevMcuw1B5G4A3K2RbCgA9rz43bG4Imz2nKm9K3X8lL "
    ];
  };

  # System-level zsh: writes /etc/zshrc, sets up completion paths, and links
  # zsh into /etc/shells so chsh/login accept it. Required when zsh is a
  # user's login shell on NixOS — home-manager alone won't do this.
  programs.zsh.enable = true;
}
