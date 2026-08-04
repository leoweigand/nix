{ machineName, ... }:

{
  environment.etc."nix-machine".text = "${machineName}\n";
}
