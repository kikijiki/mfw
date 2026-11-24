# Project dev environments

A project can declare its development environment the usual way: an `.envrc`
for [direnv](https://direnv.net), a `mise.toml` or `.tool-versions` for
[mise](https://mise.jdx.dev), a flake `devShell`, or [devenv](https://devenv.sh).
mfw evaluates it **inside a sandbox, at a commit you approved**, and gives the
result to every run and every check of that project. Nothing of it is evaluated
on the host, and the host's own direnv and mise state (`~/.local/share/direnv`,
`~/.config/mise`) is never read or written.

## Quick start

```sh
mfw env status my-project        # what runs would get, and the fix if refused
mfw env allow my-project         # approve the environment at the integration branch
mfw env build my-project         # optional: evaluate and install now, not at the next dispatch
```

`mfw env allow` prints every file and hash it records before recording them.
Running it is the approval, as with `direnv allow`. It takes `--rev <commit>` to
approve another commit. `mfw env deny my-project` refuses the project's runs
until it is allowed again.

The same approval is offered as a card in the inbox when a dispatch finds the
environment unapproved, or changed since you approved it. The card shows the
commit and each file's hash; approving it is the same as `mfw env allow --rev`.

## What is supported

The first source present wins:

| Source | Files | What runs in the env-build sandbox |
| --- | --- | --- |
| direnv | `.envrc` (with `use flake`, `use nix`, `dotenv`, `layout`, `source_env`, `PATH_add`, `watch_file`, ...) | `direnv allow`, then `direnv export json` |
| mise | `mise.toml`, `.mise.toml`, `.config/mise.toml`, `.tool-versions`, ... | `mise trust`, `mise install`, then `mise env --json` |
| flake | `flake.nix` with `devShells.<system>.default` | `nix print-dev-env --json` |
| devenv | `devenv.nix`, `devenv.yaml` | `devenv print-dev-env --json` |

A setup mfw cannot evaluate, such as a lone `shell.nix` or an `.nvmrc`, is
refused with a fix: add an `.envrc` (`use nix`) or a `mise.toml`, or set
`"env": { "source": "none" }` in the project's entry in `$MFW_HOME/config.json`
to run it on the plain host toolchain. A project is never run without the
environment it declares.

## Configuration

The project's `env` entry in `$MFW_HOME/config.json`. It is part of what you
approve: changing it asks again.

```json
{
  "name": "my-project",
  "runWorkspace": "clone",
  "env": {
    "source": "auto",
    "setup": ["bun install --frozen-lockfile"],
    "outputs": ["node_modules", "packages/*/node_modules"],
    "registries": ["registry.npmjs.org:443"],
    "extraHosts": ["gitlab.example.org:443"],
    "timeoutSeconds": 900
  }
}
```

| Key | Meaning | Default |
| --- | --- | --- |
| `source` | `auto`, `none`, `direnv`, `mise`, `flake` or `devenv` | `auto` |
| `setup` | commands that install dependencies, run in order in the env-install sandbox | none |
| `outputs` | what `setup` produces that runs reuse; one `*` segment allowed | the `node_modules` directories |
| `registries` | exact `host:port` pairs `setup` may reach | from the lockfiles present |
| `extraHosts` | further hosts the evaluation may reach, such as a flake input on another forge | none |
| `timeoutSeconds` | wall-clock limit of one evaluation or setup | 900 |

## The trust model

An approval names **one commit** and records the content hash of every
environment file at it: the source's files, every other environment file
present, and, with `setup`, the package lockfiles and `package.json`. Files the
evaluation reports reading, such as a file an `.envrc` sources or watches, are
added after the first evaluation. They belong to the approved commit, so adding
them grants nothing; they widen what counts as a change.

The hash is split in two classes:

| Class | Files | A change to it alone |
| --- | --- | --- |
| Environment definition | `.envrc` and what it sources, mise files, `flake.nix`, `flake.lock`, devenv files, `.tool-versions`, the `env` config (including `setup`), and the executing fields of `package.json` (`scripts`, `bin`, `workspaces`, ...) | asks again (an ask-first card on merge, then `mfw env allow`) |
| Package lockfiles | `bun.lock`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `Cargo.lock`, `uv.lock`, `poetry.lock`, `requirements.txt`, and the dependency fields of `package.json` | needs no approval: the merge leaves a notify-after "dependencies changed" item, and the dependencies are installed again, in the env-install sandbox with registry egress only, from that commit's lockfiles |

Nix lockfiles are in the definition class because a changed input makes the
nix daemon fetch and build from a new origin, outside the proxy. A change that
touches both classes asks again.

- Evaluation happens only at the approved commit.
- A later commit is covered while its environment definition is
  byte-identical, and the set of environment files itself is unchanged. Runs at
  that commit get the cached evaluation; nothing is evaluated again. Its
  dependencies are cached by its own lockfiles.
- A merge that changes a definition file is an ask-first card (the
  host-executed path class), and after it lands the approval no longer covers
  the base: runs are refused, and a new card asks you to allow the new commit.
- A run that edits its own `.envrc` is checked with the **approved**
  environment, never its own: an edit is evaluated only once you allow the
  commit it lands in.

## What runs where

| Step | Where | Reaches | Writes |
| --- | --- | --- | --- |
| Detect and hash the files | host, reading the repository's objects | nothing | nothing |
| Evaluate (`env-build` role) | a disposable clone of the approved commit | its own commands: the per-run proxy, with the flake and mise hosts (`containment/dev-env-egress.ts`) and `extraHosts`. With `env.nixDaemon` only: the host's nix daemon, see below | the clone, a private home, the environment's data directory (mise installs); with the daemon, the host's Nix store |
| Install (`env-install` role) | a disposable clone of the approved commit, or of a later one whose package lockfiles alone changed, with the evaluated environment applied | the per-run proxy, with the registries only | the clone; `outputs` are then moved into the cache |
| Run (`task`, `repair`) and check (`verifier`, `merge-verify`) | the run's or check's own clone | as before: the run's harness hosts, or no network for a check | as before |

The evaluated environment is cached under `$MFW_HOME/env/cache`, keyed by the
approval's definition: the filtered variables, the `PATH` entries, the Nix
store paths they need, and the environment's data. The installed dependencies
are cached beside it, keyed also by the package lockfiles they came from. A run binds those
store paths and the data read-only, one by one; the rest of the store stays
hidden. Dependencies are copied into each fresh clone, with a reflink where the
filesystem has one.

The variables come from project code, so they are filtered before any sandbox
gets them, and the profile schema checks them again at every launch: names the
sandbox owns (`HOME`, `TMPDIR`, `XDG_*`, `GIT_*`, the proxy) and names that change
how programs load code or start a shell (`LD_*`, `DYLD_*`, `BUN_*`,
`NODE_OPTIONS`, `GLIBC_TUNABLES`, `BASH_ENV`, ...) are dropped, values are
size-capped, and `PATH` keeps only entries inside the environment's store
closure, its data, or the run's own tree. `mfw env status` lists what was dropped.

A check's `checkPrefix` that only loads the environment (`direnv exec .`,
`nix develop -c`, `devenv shell`, `mise exec --`) is dropped: the approved
environment is already applied. Without an approved environment such a prefix
is refused rather than run.

## The nix daemon is outside the proxy

direnv with nix (`use flake`, `use nix`), flake and devenv sources need the
host's nix daemon. mfw gives it to an evaluation only when the project sets
`"nixDaemon": true` in its `env` entry, which is part of the approval and is
shown on the card and by `mfw env allow` as **NIX DAEMON: ON**. Without it these
sources are refused with that fix, and a plain `.envrc` runs with no daemon.

Through the daemon, the approved code is **not** contained by the proxy:

- the daemon fetches and builds with this host's network, outside the proxy,
  with no allowlist, no upload budget and no record, so a fixed-output
  derivation can send what the evaluation can read to any host;
- its builders can reach this machine's loopback services, mfw's own listener
  included;
- the evaluation can read the whole Nix store read-only, which includes the
  source snapshots of your other flake projects;
- it can ask the daemon to collect garbage, which deletes every store path no
  root holds. mfw registers GC roots for each cached environment's closure, so
  its own environments survive; your other unrooted dev shells and build
  results do not.

Set `nixDaemon` only for a project you trust that far. mise needs no daemon.
mfw also refuses the evaluation when the daemon's build sandbox is off
(`nix config show sandbox` is not `true`), when the store's filesystem has less
than `env.minStoreFreeMb` free (default 4096), and fails it when it grew the
store by more than `env.maxStoreGrowthMb` (default 16384).

## Requirements and refusals

- The tool for the source on the host's `PATH`: `direnv`, `mise`, `nix` or
  `devenv`.
- For direnv with nix, flakes and devenv: `env.nixDaemon`, Nix in multi-user
  (daemon) mode with `sandbox = true`, and a daemon that does **not** trust
  your user (`trusted-users`). A trusted client could add
  unsigned paths to the store or choose its own substituters, so the evaluation
  is refused when the daemon says it trusts you, or does not say. Keep your user
  in `allowed-users` instead.
- `mfw doctor` reports each project's environment: none, approved and evaluated,
  approved but not evaluated yet (a warning: the next dispatch does it), or the
  refusal with its fix.

A dispatch refused for the environment says why: `env_not_approved` (allow it,
or approve the card), or `env_unavailable` with the last lines of the
evaluation's log. `mfw env build <project>` retries and prints the whole log.
