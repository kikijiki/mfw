# Agent network access (egress)

A sandboxed task or repair run has no network of its own. Its only way out is
a proxy on the host, one per run, reached through a unix socket that only that
run can see. Other run kinds do not use this path yet.

## What a run can reach

Each harness has a fixed list of exact `host:port` pairs, in
`packages/daemon/src/containment/egress-allowlists.ts`. Everything else is
refused, including IP addresses, private and link-local ranges, and the host's
own addresses, even when an allowed name resolves to one of them.

| Harness | Hosts (port 443) | When |
| --- | --- | --- |
| Claude | `api.anthropic.com`, `platform.claude.com` | always |
| Claude | `http-intake.logs.us5.datadoghq.com`, `browser-intake-us5-datadoghq.com` | telemetry opt-in |
| Codex | `chatgpt.com`, `auth.openai.com` | always |
| Codex | `api.openai.com` | the run has `OPENAI_API_KEY` in its launch environment |
| Codex | `ab.chatgpt.com` | telemetry opt-in |

A key saved with Codex's own login command does not count as API-key auth,
because mfw never reads a CLI's stored login. Such a run needs the key granted
through its launch environment to reach `api.openai.com`.

The TLS hello of every tunnel must name the host the tunnel was opened for. A
hello that names another host, names none, or is split across TLS records is
refused before anything reaches the upstream.

## Settings

These are per-project keys in `$MFW_HOME/config.json`.

| Key | Default | What it does |
| --- | --- | --- |
| `agentEgressTelemetry` | `false` | lets runs reach their CLI's telemetry hosts |
| `agentEgressUploadBudget.perDestinationBytes` | 1 GiB | most one run may send to one `host:port` |
| `agentEgressUploadBudget.totalBytes` | 2 GiB | most one run may send in total |

The budget covers every launch of a run. When a run crosses it, the chunk that
crossed is not forwarded, all its tunnels close, new ones are refused, and the
inbox shows a critical item. The defaults are deliberately generous and have
not been calibrated against real runs.

## What this does not protect against

- **Allowed hosts can receive data.** A proxy cannot tell a read from a write,
  and the vendors' APIs accept other people's keys. A run can read its fleet
  login, and can send it or workspace data to an allowed host, up to the
  budget. Traffic is bounded and recorded, not prevented.
- **A `Host` header inside TLS is invisible.** The proxy checks the TLS hello
  and cannot see what is sent after it.
- **The toolchain is not an execution boundary.** On NixOS the sandbox holds
  only the store closure of the declared tools, with undeclared executables
  hidden. `bun` and `node` are declared and run any code, and a run can execute
  a binary it wrote. On other distributions `/usr` is bound whole.

## Known limits

- **Half-close does not work.** Under Bun 1.3.13, a reply sent after the client
  has closed its sending side is lost, in both the proxy and the in-sandbox
  relay. A client that sends its whole request, shuts down writing and then
  waits for the answer will not get one. HTTP and TLS clients normally keep the
  connection open and are not affected.
- **Git commands that need Perl or Python do not run in the sandbox**, because
  those interpreters are hidden even though they are in git's closure:
  `git send-email`, `git cvsimport`, `git cvsexportcommit`, `git cvsserver`,
  `git archimport` (Perl) and `git p4` (Python). `git instaweb` also calls Perl
  for some web servers. Git's built-in commands and its shell scripts, such as
  `filter-branch` and `request-pull`, work when the tools they call are
  declared.
- **The proxy has no memory or task limit of its own.** `ulimit -v` breaks Bun,
  and a host without a systemd user manager has no scope to put it in. It is
  limited to 512 open files and 64 connections, and a machine runs at most 32
  proxied runs. A launch past that is refused.
