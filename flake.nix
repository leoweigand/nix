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

  outputs =
    {
      self,
      nixpkgs,
      nix-darwin,
      home-manager,
      opnix,
      disko,
      ...
    }@inputs:
    {
      packages = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-darwin" ] (system: {
        automation = nixpkgs.legacyPackages.${system}.callPackage ./packages/automation/default.nix { };
      });

      checks.x86_64-linux.automation = self.packages.x86_64-linux.automation;
      checks.x86_64-linux.automation-sandbox = import ./tests/automation-sandbox.nix {
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
      };

      devShells = nixpkgs.lib.genAttrs [ "x86_64-linux" "aarch64-darwin" ] (system: {
        default = nixpkgs.legacyPackages.${system}.mkShell {
          packages = [ nixpkgs.legacyPackages.${system}.nodejs_26 ];
        };
      });

      checks.x86_64-linux.cloudflare-publication = import ./tests/cloudflare-publication.nix {
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
        picard = self.nixosConfigurations.picard;
      };

      checks.x86_64-linux.edge-dns = import ./tests/edge-dns.nix {
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
        picard = self.nixosConfigurations.picard;
      };

      checks.x86_64-linux.authentication = import ./tests/authentication.nix {
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
        picard = self.nixosConfigurations.picard;
      };

      checks.x86_64-linux.internal-api = import ./tests/internal-api.nix {
        pkgs = nixpkgs.legacyPackages.x86_64-linux;
        picard = self.nixosConfigurations.picard;
      };

      nixosConfigurations = {
        # Picard - Main homelab server (NixOS VM on Unraid)
        picard = nixpkgs.lib.nixosSystem {
          system = "x86_64-linux";
          specialArgs = {
            inherit inputs;
            machineName = "picard";
          };
          modules = [
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
          specialArgs = {
            inherit inputs;
            machineName = "ro";
          };
          modules = [
            ./machines/ro/configuration.nix
            home-manager.darwinModules.home-manager
          ];
        };

        crusher = nix-darwin.lib.darwinSystem {
          system = "aarch64-darwin";
          specialArgs = {
            inherit inputs;
            machineName = "crusher";
          };
          modules = [
            ./machines/crusher/configuration.nix
            home-manager.darwinModules.home-manager
          ];
        };
      };
    };
}
