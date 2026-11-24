# mfw as a compiled install in the Nix store (see tools/install-build.ts):
#
#   $out/bin/mfw, $out/bin/mfw-board     the compiled executables
#   $out/lib/mfw/                        the server bundle and install.json
#
# The server's pinned runtime is this derivation's `bun`, recorded at its store
# path. Nothing is fetched at build time except `nodeModules`, a fixed-output
# derivation of `bun install --frozen-lockfile --ignore-scripts`.
#
# `nodeModulesHash` changes whenever bun.lock does. While it is `lib.fakeHash`
# the build cannot succeed (a fixed-output derivation must match its hash), and
# evaluation warns with the one-time command that prints the real one:
#   nix build .#mfw.nodeModules 2>&1 | grep 'got:'
# then put that `sha256-...` in flake.nix in place of `pkgs.lib.fakeHash`.
{
  lib,
  stdenvNoCC,
  bun,
  nodejs,
  src,
  version,
  gitRev ? "unknown",
  sourceDateEpoch ? 0,
  nodeModulesHash,
}: let
  placeholder = nodeModulesHash == lib.fakeHash;
  checkedHash =
    if placeholder
    then
      lib.warn ''
        mfw: nodeModulesHash is still lib.fakeHash, so this build will fail with a
        hash mismatch. Get the real hash once (it needs the network):
          nix build .#mfw.nodeModules 2>&1 | grep 'got:'
        and put it in flake.nix in place of pkgs.lib.fakeHash.''
      nodeModulesHash
    else nodeModulesHash;
  nodeModules = stdenvNoCC.mkDerivation {
    pname = "mfw-node-modules";
    inherit version src;
    nativeBuildInputs = [bun];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      export HOME=$TMPDIR
      bun install --frozen-lockfile --ignore-scripts --no-progress
      runHook postBuild
    '';
    # Every node_modules directory, with bun's relative links kept as they are.
    installPhase = ''
      runHook preInstall
      mkdir -p $out
      find . -name node_modules -type d -prune -print0 \
        | xargs -0 -I{} cp -a --parents {} $out/
      runHook postInstall
    '';
    dontFixup = true;
    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = checkedHash;
  };
in
  stdenvNoCC.mkDerivation {
    pname = "mfw";
    inherit version src;
    # node is a BUILD-time tool only: vite and friends ship `#!/usr/bin/env node`
    # shebangs, and the build sandbox has no /usr/bin/env. Nothing from it reaches
    # the output (dontFixup, and the compiled executables embed bun, not node).
    nativeBuildInputs = [bun nodejs];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      cp -a ${nodeModules}/. ./
      chmod -R u+w .
      patchShebangs --build node_modules apps/start/node_modules packages
      export HOME=$TMPDIR
      export SOURCE_DATE_EPOCH=${toString sourceDateEpoch}
      export MFW_BUILD_GIT_SHA=${gitRev}
      bun run build
      runHook postBuild
    '';
    installPhase = ''
      runHook preInstall
      bun run tools/install-build.ts --prefix $out --runtime ${bun}/bin/bun \
        --runtime-in-place --skip-build
      runHook postInstall
    '';
    # `nix build .#mfw.nodeModules` computes the hash above.
    passthru = {inherit nodeModules;};
    # A compiled bun executable carries its program after the ELF image:
    # stripping or patching it would cut that off.
    dontStrip = true;
    dontPatchELF = true;
    dontFixup = true;
    meta = {
      description = "mfw: local-first orchestrator for fleets of coding agents (compiled)";
      license = lib.licenses.mit;
      mainProgram = "mfw";
      platforms = ["x86_64-linux"];
    };
  }
