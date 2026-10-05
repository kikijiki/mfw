{
  description = "mfw - local-first autonomous project orchestrator";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs_22
            sqlite
            git
            tmux        # agent runs are hosted in detached tmux sessions
            bubblewrap  # optional: MFW-33 item 3's agentIsolation: "bwrap"
          ];

          shellHook = ''
            echo "mfw dev shell - bun $(bun --version), node $(node --version)"
          '';
        };
      });
}
