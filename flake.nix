{
  description = "mfw - local-first autonomous project orchestrator";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    (flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        version = (builtins.fromJSON (builtins.readFile ./packages/cli/package.json)).version;
        # The compiled install: `mfw` and `mfw-board`, the server bundle and its
        # pinned runtime (this nixpkgs' bun). See packaging/nix/mfw.nix.
        mfw = pkgs.callPackage ./packaging/nix/mfw.nix {
          inherit version;
          src = self;
          gitRev = self.rev or self.dirtyRev or "unknown";
          sourceDateEpoch = self.lastModified or 0;
          # Not set yet: the build fails, and evaluation warns, until this is the
          # real hash. One-time, with the network:
          #   nix build .#mfw.nodeModules 2>&1 | grep 'got:'
          # Refresh it the same way whenever bun.lock changes.
          nodeModulesHash = pkgs.lib.fakeHash;
        };
      in
      {
        packages = {
          inherit mfw;
          # The board executable alone, from the same install (its sibling check
          # follows the link back to it).
          mfw-board = pkgs.runCommand "mfw-board-${version}" { } ''
            mkdir -p $out/bin
            ln -s ${mfw}/bin/mfw-board $out/bin/mfw-board
          '';
          default = mfw;
        };

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs_22
            sqlite
            git
            tmux        # agent runs are hosted in detached tmux sessions
            bubblewrap  # required: agentIsolation defaults to "bwrap"
          ];

          shellHook = ''
            echo "mfw dev shell - bun $(bun --version), node $(node --version)"
          '';
        };
      }))
    // {
      # The user service. Imported from this flake it runs the compiled install;
      # imported as a path (packaging/mfw.home-manager.nix) it runs a checkout,
      # which is the development setup.
      homeManagerModules.default = { pkgs, lib, ... }: {
        imports = [ ./packaging/mfw.home-manager.nix ];
        services.mfw-server.package =
          lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.mfw;
      };
    };
}
