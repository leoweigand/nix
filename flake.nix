{
  description = "NixOS configurations for homelab infrastructure";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    nix-darwin = {
      url = "github:LnL7/nix-darwin/master";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

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

  outputs = { self, nixpkgs, nix-darwin, home-manager, opnix, disko, ... }@inputs: {
    nixosConfigurations = {
      # Picard - Main homelab server (NixOS VM on Unraid)
      picard = nixpkgs.lib.nixosSystem {
        system = "x86_64-linux";
        specialArgs = { inherit inputs; };
        modules = [
          { nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (nixpkgs.lib.getName pkg) [ "n8n" ]; }
          ./machines/picard/configuration.nix
          ./machines/picard/disko.nix
          disko.nixosModules.disko
          opnix.nixosModules.default
          home-manager.nixosModules.home-manager
          ./modules/users/leo
        ];
      };
    };

    darwinConfigurations = {
      ro = nix-darwin.lib.darwinSystem {
        system = "aarch64-darwin";
        specialArgs = { inherit inputs; };
        modules = [
          { nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (nixpkgs.lib.getName pkg) [ "1password-cli" ]; }
          ./machines/ro/configuration.nix
          home-manager.darwinModules.home-manager
        ];
      };
    };
  };
}
