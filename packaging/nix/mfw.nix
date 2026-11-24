# mfw as a compiled install in the Nix store (see tools/install-build.ts):
#
#   $out/bin/mfw, $out/bin/mfw-board     the compiled executables
#   $out/lib/mfw/                        the server bundle and install.json
#
# The server's pinned runtime is this derivation's `bun`, recorded at its store
# path. Nothing is fetched at build time except `nodeModules`, a fixed-output
# derivation of `bun install --frozen-lockfile --ignore-scripts`.
#
# `nodeModulesHash` changes whenever bun.lock does. To refresh it, build once
# with `lib.fakeHash` and copy the hash Nix reports.
{
  lib,
  stdenvNoCC,
  bun,
  src,
  version,
  gitRev ? "unknown",
  sourceDateEpoch ? 0,
  nodeModulesHash,
}: let
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
    outputHash = nodeModulesHash;
  };
in
  stdenvNoCC.mkDerivation {
    pname = "mfw";
    inherit version src;
    nativeBuildInputs = [bun];
    dontConfigure = true;
    buildPhase = ''
      runHook preBuild
      cp -a ${nodeModules}/. ./
      chmod -R u+w .
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
