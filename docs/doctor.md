# Checking a host: `mfw doctor` and `mfw init`

`mfw doctor` checks this machine and this install. It reports and never
repairs: each problem comes with one fix, as a command or config change for you
to apply.

```sh
mfw doctor                    # grouped report
mfw doctor --json             # for scripts (schemaVersion 1)
mfw doctor --no-exec-harness  # do not run `claude --version` or `codex --version`
```

| Exit code | Meaning |
| --- | --- |
| 0 | no blockers (warnings may exist) |
| 1 | at least one blocker |
| 2 | usage error |
| 3 | refused inside an agent run |

A **blocker** stops autonomous runs or leaves the install unsafe. A **warning**
degrades it. A **note** is worth knowing. A check that cannot finish is a
blocker, because an unknown is not a pass.

## What it never does

- **It writes nothing.** Databases are read as bytes into a private in-memory
  copy, because SQLite's read-only mode still writes to a WAL database's `-shm`
  file. Git runs with optional locks off.
- **It reads no secret.** Token and credential files are only stat'ed. The auth
  store is queried for counts and for whether a password exists.
- **It runs no model.** Agent CLIs get `--version` only, with no home directory,
  and only from a `PATH` directory an agent cannot write. A CLI found anywhere
  else is reported and not run.
- **It does not repeat what it finds.** URL credentials, API tokens and terminal
  control characters are removed from all output, and an invalid config is
  described by the location of the error, not its content.

## Inside an agent sandbox

`mfw doctor` and `mfw init` refuse with exit code 3 when the environment marks
an agent run. A report from there would describe the sandbox's masked view as if
it were the host. The markers are a courtesy, since an agent can unset them. The
boundary is that `$MFW_HOME` is hidden in the sandbox.

## Limits

- **Public remotes.** The doctor makes no network calls, so it recognises public
  *forges* by host name and cannot tell whether your repository is public.
- **Exposure.** `mfw doctor` judges the environment of the shell you run it in.
  A systemd unit may set other values. The Settings > Health panel judges the
  running server's own environment.
- **The Health panel** does not run agent CLIs, so it shows them as skipped.
- **Tool versions.** tmux, git and bun are reported without a minimum version,
  because mfw does not declare one. bwrap has a real minimum, 0.10.0, or an older
  build with `--bind-fd` backported.

## First run

```sh
mfw init                               # doctor, setup token location, next steps
mfw init --project ~/src/app           # also print a minimal project entry
mfw init --project ~/src/app --write   # add it to $MFW_HOME/config.json
```

`mfw doctor --first-run` is the same flow. It prints the path of the setup token,
never the token. Without `--write` it changes nothing. `--write` is refused while
the server is running, or when the name or root is already configured.

The entry uses `runWorkspace: "clone"`, because sandboxed runs cannot start from
a worktree. It never sets `pushUrl`: choosing where merges are pushed is yours.
