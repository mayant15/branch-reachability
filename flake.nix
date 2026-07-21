{
  description = "";
  inputs.nixpkgs.url = "flake:nixpkgs/nixos-26.05";
  outputs = { nixpkgs, ... }:
    let
      systems = ["x86_64-linux"];
      forEachSystem = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forEachSystem ( system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShellNoCC {
            packages = with pkgs; [
              nodejs_24
            ];
          };
        }
      );
    };
}
