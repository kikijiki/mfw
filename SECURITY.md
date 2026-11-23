# Security policy

mfw starts coding agents on your machine and can merge and push what they
produce. Please read this page before you point it at a repository you care
about. The details, with the code behind each claim, are in the
[threat model](docs/threat-model.md).

## Reporting a vulnerability

Please report privately and do not open a public issue.

**Contact:** `<security contact: the maintainer fills this in before release>`

Include the mfw commit, your OS and kernel, your `bwrap` and git versions, the
project settings involved (`agentIsolation`, `approvalMode`, `runWorkspace`), and
the steps to reproduce. Leave out real tokens and private repository content.

mfw is maintained on a best-effort basis, so no response time is promised. Please
give the maintainer a reasonable chance to fix the problem before you publish it.

Especially useful reports:

- anything a sandboxed agent can do outside its sandbox;
- agent-written content that reaches host execution without an owner approval;
- any API call that works without a valid credential or beyond a token's scope;
- a protection these documents claim that the code does not enforce.

## Supported versions

mfw is pre-release (`0.x`). Only the latest commit of the default branch gets
security fixes, and there are no backports. Upgrades can change the database
and the configuration, so back up `$MFW_HOME` and each project's `.mfw/` first.

## What mfw protects against

With the default `agentIsolation: "bwrap"`, on a host that passes the sandbox
probe:

- **A hostile or mistaken agent.** It runs in a private clone with a synthetic
  home, a read-only system, no capabilities, a seccomp filter and its own network
  namespace. It cannot see your home directory, `$MFW_HOME` or the primary
  repository.
- **Launching without proof.** An autonomous launch needs a fresh, passing,
  single-use probe of that exact sandbox. If the proof is missing, the run is
  refused. It never falls back to running unsandboxed.
- **Open network access.** A run reaches the network only through its own proxy,
  which allows a short list of exact vendor hosts.
- **Tampered results.** The host imports a run's work as a validated git bundle
  and never runs git inside the agent's repository. Checks run in a disposable,
  no-network sandbox.
- **Silent changes to what the host executes.** A merge that touches agent
  configuration, CI, git behaviour or build entry points waits for your approval.
- **Unauthenticated access.** Sign-in is always on, including on loopback. The
  server refuses a non-loopback listener without TLS or a trusted proxy.

## What mfw does not protect against

- **Data leaving through allowed hosts.** A run can read its agent CLI's login and
  can send it, or the code it can read, to an allowed vendor host. Upload budgets
  limit this and the proxy records it, but neither prevents it.
- **Code you merge.** Ordinary source changes merge and push without a card when
  their checks pass. That code runs with your rights once you build or run it.
- **Unsandboxed modes.** `agentIsolation: "none"`, ACP agents, interactive worktree
  checks and armed host triggers run as your user.
- **Remote targets.** SSH and RunPod are [experimental](docs/experimental.md), off
  by default, and do not have the local sandbox's protections.
- **A stolen owner session.** The owner can configure commands the host runs, so
  treat that session like a shell on your machine.
- **Your own user account, kernel or tools.** A process already running as you, a
  kernel or `bwrap` flaw, or a compromised agent CLI is outside this model.

Some protections have not yet been exercised end to end, including the systemd
resource limits on a real host and real agent CLIs under the full profile. The
[threat model](docs/threat-model.md#not-yet-verified) lists them.
