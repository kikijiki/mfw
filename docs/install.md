# Installing a compiled build

A compiled install is how mfw is meant to run outside development. It is one
directory, and nothing in it is read from a checkout:

```
<prefix>/bin/mfw               the CLI and every host process (compiled)
<prefix>/bin/mfw-board         the board CLI (compiled)
<prefix>/lib/mfw/install.json  the install manifest: a sha256 for each part
<prefix>/lib/mfw/server/       the server bundle (`mfw-server`: engine, API, UI)
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
  loaded and removed. `$TMPDIR` must be writable and allow execution (not mounted `noexec`); the
  install itself never needs to be writable.
- `mfw board` runs the `mfw-board` next to `mfw` (checked against the manifest),
  or one on `PATH` only from a root-owned directory agents cannot write.
- `mfw __host` is refused from a checkout, inside an mfw sandbox, and from
  inside the agent launcher.
- Every process the host starts that is `mfw` or bun gets an allowlisted
  environment: a fixed base (`PATH`, `HOME`, locale, temp, the user bus, TLS and
  proxy settings), `MFW_*`, and the run's declared provider and secret names.
  `BUN_*`, `NODE_*`, `LD_*`, `DYLD_*` and `GLIBC_TUNABLES` never pass, and a
  provider environment that sets one is refused at launch.

`mfw` cannot refuse bun's runtime variables itself: `BUN_OPTIONS` preloads code
before any of its own code runs, and `BUN_BE_BUN` makes it a plain bun. The
server never passes them. If you set one in your own shell, or in a unit you
write, and run `mfw` there, that code runs with your own rights. Keep them out
of the environment `mfw server` starts in.

The hashes catch a partial install, mixed versions and damaged files. They do not
stop someone who can write the install, so the install's location is checked too.
At `mfw server` start, in `mfw version`, in `mfw doctor` and at every agent launch,
the prefix, `bin/`, `lib/mfw/` and every parent, every file under `lib/mfw/`, both
executables and the runtime must be owned by root (or be in the Nix store), not be
group- or world-writable, and not sit inside a tree agents write (your home, the
temp directories, project roots). An install that fails still runs, loudly: the
server warns at every start, the doctor reports a blocker, and **every autonomous
launch is refused** until you fix it or accept that exact prefix in
`$MFW_HOME/config.json`:

```json
{ "acknowledgeUntrustedInstall": "<the prefix that mfw version names>" }
```

Accepting it means any process running as you can change the code the next
autonomous run uses on the host.

Each launch re-hashes the whole install, and the server re-hashes `mfw` before
it starts each host process, reading through one open descriptor. The process is
then started by path, through `run.sh` and tmux, where no descriptor can follow,
so a file renamed between the hash and the start is not caught: that needs write
access to the install, which the location check rules out. Server code the bundle
loads lazily is trusted for the life of the server once it starts.

## With Nix

The flake builds the install into the store, with nixpkgs' bun as the pinned
runtime:

```sh
nix build .#mfw          # result/bin/mfw, result/bin/mfw-board, result/lib/mfw
```

The `node_modules` step is a fixed-output derivation, and its hash in
`flake.nix` is not set yet (`pkgs.lib.fakeHash`). Until it is, `nix build .#mfw`
fails with a hash mismatch, and evaluating the flake warns with this one-time
command (it needs the network):

```sh
nix build .#mfw.nodeModules 2>&1 | grep 'got:'
```

Put the `sha256-...` it prints in place of `pkgs.lib.fakeHash`, and refresh it
the same way whenever `bun.lock` changes.

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
tar -C ./mfw-install --owner=0 --group=0 --numeric-owner -czf mfw.tar.gz .
```

`--bun-executable` compiles `mfw` and `mfw-board` from the official bun. A bun from
Nix links against the Nix store, so executables made from it run only where that
store is present. `--runtime` is the bun that runs the server; it is copied into
`lib/mfw/runtime/` and hashed into the manifest.

Install it as root, so that agents cannot change it:

```sh
sudo mkdir -p /opt/mfw && sudo tar -C /opt/mfw --no-same-owner -xzf mfw.tar.gz
/opt/mfw/bin/mfw version     # verifies every part of the install
```

Then point `packaging/mfw-server.service` at `/opt/mfw/bin/mfw server` (the
compiled line in the unit).

Sandboxed runs also need a `bun` on the service's `PATH`: the egress relay and
the WIP helper run on it inside the sandbox. It must be in a root-owned directory
(a distribution package, `/usr/local/bin` installed as root, or the Nix profile);
mfw ignores one in a directory you can write, and refuses the launch. Do not add
`~/.bun/bin` to make it work: anything you can write, any process running as
you can replace.

## Installing a new version

mfw is in early development, and there is no migration path between development
versions: a new version may change the database schemas, the configuration and
the layout under `$MFW_HOME`, and it does not read what an older one wrote.
Install the new version as a fresh start:

1. Stop the service, and stop any agents still running (from the UI, or
   `tmux -L mfw kill-server`).
2. Delete `$MFW_HOME` and each project's `.mfw/` (the board, in its own folder,
   is plain files and stays).
3. Install the new version (a new Nix generation, or a new prefix such as
   `/opt/mfw-0.2.0`), and point the service or a symlink at it.
4. `mfw version` must print `install: ... verified`; then start the service and
   repeat first-run setup.

A database from another version is refused at open with the fix, never read.

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
