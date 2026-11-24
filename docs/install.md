# Installing a compiled build

A compiled install is how mfw is meant to run outside development. It is one
directory, and nothing in it is read from a checkout:

```
<prefix>/bin/mfw               the CLI and every host process (compiled)
<prefix>/bin/mfw-board         the board CLI (compiled)
<prefix>/lib/mfw/install.json  the install manifest: a sha256 for each part
<prefix>/lib/mfw/server/       the server bundle (`mfw-server`: daemon, API, UI)
<prefix>/lib/mfw/public/       the web UI's assets
<prefix>/lib/mfw/runtime/bun   the pinned bun that runs the server (tarball installs)
<prefix>/share/mfw/            third-party notices for the executables
```

From a checkout, `bun run build && bun run start` is the development setup. It
runs the same bundle, but from the working tree.

## What runs on the host

- `mfw server` checks the whole install against `install.json`, and against the
  digests `mfw` was built with, then runs the bundle with the pinned bun and no
  `bunfig.toml` or `.env`. A mismatch refuses to start.
- Every helper the server starts on the host (the agent launcher, the egress
  proxy, the drivers and bridges, the brain transcript step) is
  `mfw __host <id>`: the same `mfw`, checked against its hash in the manifest
  before each use. Inside `mfw`, a helper re-executes `/proc/self/exe`, the
  image already running. The install has no script files to load.
- The scripts a sandbox runs (the egress relay, the WIP helper, the brain's MCP
  server) are embedded in `mfw` and copied out of it into each run.
- The database migrations are embedded in `mfw` with their hash manifest, and
  the server bundle carries its own verified copy. Neither reads a checkout, and
  `MFW_MIGRATIONS_DIR` is refused.
- The libsql addon is embedded in `mfw`. On first use it is written to a fresh
  private directory under `$TMPDIR`, checked against the hash recorded at build,
  loaded and removed. `$TMPDIR` must be writable; the install itself never is.
- `mfw board` runs the `mfw-board` next to `mfw` (checked against the manifest),
  or one on `PATH` only from a root-owned directory agents cannot write.
- `mfw __host` is refused from a checkout, inside an mfw sandbox, from inside the
  agent launcher, and with bun runtime options in the environment
  (`BUN_OPTIONS`, `BUN_BE_BUN`). A compiled `mfw` refuses those options for
  every command.

The hashes catch a partial upgrade, mixed versions and damaged files. They do not
stop someone who can write the install, so put it where agents cannot write: the
Nix store, or a root-owned prefix such as `/opt/mfw`. Agents run with your user
id, so a prefix in your home is only as safe as your home.

## With Nix

The flake builds the install into the store, with nixpkgs' bun as the pinned
runtime:

```sh
nix build .#mfw          # result/bin/mfw, result/bin/mfw-board, result/lib/mfw
```

The `node_modules` step is a fixed-output derivation. Its hash in `flake.nix`
must be refreshed whenever `bun.lock` changes: build once, and copy the hash Nix
reports in place of `pkgs.lib.fakeHash`.

For the service, import the flake's module. It runs `mfw server` from the store
and keeps the scheduler off until you enable it:

```nix
imports = [ inputs.mfw.homeManagerModules.default ];
```

Importing `packaging/mfw.home-manager.nix` by path instead runs a checkout
(development), as before.

## From a tarball

Assemble the install on a build machine (nothing is downloaded except the bun
release asset, and only when you ask for it):

```sh
bun install --frozen-lockfile
bun run build
# The official bun, checked against packaging/bun-runtime.json. Pass --zip to use
# a release zip you downloaded yourself instead.
bun run tools/fetch-bun-runtime.ts --out ./bun-official
bun run tools/install-build.ts --prefix ./mfw-install --runtime ./bun-official \
  --bun-executable ./bun-official --read-only
tar -C ./mfw-install -czf mfw.tar.gz .
```

`--bun-executable` compiles `mfw` and `mfw-board` from the official bun. A bun from
Nix links against the Nix store, so executables made from it run only where that
store is present. `--runtime` is the bun that runs the server; it is copied into
`lib/mfw/runtime/` and hashed into the manifest.

Install it as root, so that agents cannot change it:

```sh
sudo mkdir -p /opt/mfw && sudo tar -C /opt/mfw -xzf mfw.tar.gz
/opt/mfw/bin/mfw version     # verifies every part of the install
```

Then point `packaging/mfw-server.service` at `/opt/mfw/bin/mfw server` (the
compiled line in the unit).

## Upgrading

An install is replaced whole, never edited:

1. Stop the service and drain running agents (they survive a restart, but a new
   version should not adopt runs of the old one mid-flight).
2. Back up `$MFW_HOME` and each project's `.mfw/`. Migrations run one way at the
   first start.
3. Install the new version beside the old one (a new Nix generation, or a new
   prefix such as `/opt/mfw-0.2.0`), and switch the service or a symlink to it.
4. `mfw version` must print `install: ... verified`; then start the service.

Rolling back means switching back and restoring the backup from step 2.

## `mfw version`

It prints the version, commit, build time and bun version, then the integrity
hashes: the embedded migration manifest, the libsql addon, the embedded scripts,
the server tree and runtime digests the executable was built with, and each entry
of `install.json`, with whether the install verifies. `mfw doctor` reports the
same check as `install.build`.

## Building it yourself

| Command | Output |
| --- | --- |
| `bun run compile -- --out <dir>` | `mfw` and `mfw-board` alone (no server) |
| `bun run build:install -- --prefix <dir> --runtime <bun>` | a full install |
| `bun run smoke:compiled` | assembles a temporary install and runs the auth smoke and a caged agent launch against it |

Builds are reproducible in the ways that matter here: the stamped time is
`SOURCE_DATE_EPOCH`, or the commit time when that is unset; no builder path is
embedded; and `MFW_BUILD_GIT_SHA` names the commit for a build without the
repository. Only `x86_64-linux` is built today. Other targets need their libsql
addon installed and a pinned bun; the compile step refuses a target it cannot
build.
