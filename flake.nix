{
  description = "NixOS configurations for homelab infrastructure";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.05";

    # 1Password integration for secret management
    opnix = {
      url = "github:brizzbuzz/opnix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Declarative disk partitioning
    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, opnix, disko, ... }@inputs: {
    nixosConfigurations = {
      # Riker - Hetzner VPS for development/testing
      riker = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit inputs; };
        modules = [
          ./machines/riker/configuration.nix
          opnix.nixosModules.default
        ];
      };

      # Picard - Main homelab server (NixOS VM on Unraid)
      picard = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit inputs; };
        modules = [
          ./machines/picard/configuration.nix
          ./machines/picard/disko.nix
          disko.nixosModules.disko
          opnix.nixosModules.default
        ];
      };
    };
  };
}
