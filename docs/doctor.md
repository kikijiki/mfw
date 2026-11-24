# Checking a host: `mfw doctor` and `mfw init`

`mfw doctor` checks this machine and this install. It reports and never
repairs: each problem comes with one fix, as a command or config change for you
to apply.

```sh
mfw doctor                     # grouped report
mfw doctor --json              # for scripts (schemaVersion 1), redacted
mfw doctor --json --no-redact  # with local paths and file names
mfw doctor --redact            # safe to paste into an issue
mfw doctor --harness-versions  # also run each installed agent CLI's version command
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
- **It does not print a secret it can recognise.** Token and credential files
  are only stat'ed. `auth.db` is loaded into memory as a whole, password hashes
  included, and only counts and "a password exists" are queried from it.
- **It runs no model, and by default no agent CLI.** `--harness-versions` runs
  `--version` with no home directory. That hides credentials from a well-behaved
  CLI but is not a boundary: the process keeps your user id.
- **It runs only trusted binaries.** A binary, its symlink targets and every
  parent directory must be root-owned and not group- or world-writable. Project
  roots, `$HOME` and the temp directories never qualify. This is the same rule
  every host tool in mfw is resolved with.
- **A cloned repository cannot stall it.** Project files are opened without
  following links or blocking, capped at 1 MiB, and each project has a deadline.

## Sharing a report

`--redact`, the default for `--json` and the Settings > Health copy button, removes
home paths, the user name, URL paths and queries, untracked file names, bidi
controls, and token shapes such as `ghp_`, `github_pat_`, `AKIA`, `xoxb-` and JWTs.
`--redact-projects` also hides project names. Redaction recognises known shapes,
so read a report before you post it.

## Printed fixes

Every path in a printed command is shell-quoted. A path with control characters
gets advice instead of a command. A recursive `chown` or a `chmod` is printed only
for a directory that holds an mfw marker file and is not a system directory.
The AppArmor fix is a profile for your exact bwrap binary, and it leaves the
host-wide restriction on. It stops if a profile of that name already exists. A
fix that re-enables user namespaces for the whole host says so.

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
- **The Health panel** never runs agent CLIs. It shows whether they are installed.
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
the server is running, when the name or resolved root is already configured, when
`config.json` is a symlink, and when a save would delete keys this version does
not know. It writes the file with mode 0600, or keeps a stricter mode.

The entry keeps the defaults (a private clone per run, in the sandbox). It never
sets `pushUrl`: choosing where merges are pushed is yours.
