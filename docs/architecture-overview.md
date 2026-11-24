# Architecture overview

mfw is a local-first orchestrator for coding agents. One server process,
`mfw-server`, holds the engine, the API and the web UI. Agents run as separate sandboxed processes. The
board is a folder of markdown files, and SQLite keeps the run records.

For the security view of the same system, see the
[threat model](threat-model.md).

## Components

```
  browser / phone          MCP clients, scripts           terminal
        │ session + key           │ scoped token              │
        ▼                         ▼                           ▼
 ┌───────────────────────────────────────────────┐   ┌────────────────┐
 │ mfw-server (one process)                      │   │ mfw / mfw-board│
 │                                               │   └───────┬────────┘
 │  request guard ─ auth ─ typed API ─ web UI    │           │
 │                    │                          │           │
 │  ┌─────────────────▼───────────────────────┐  │           │
 │  │ engine                                  │  │           │
 │  │  scheduler ─ run engine ─ supervisor    │  │           │
 │  │  finalizer ─ verifier ─ merge queue     │  │           │
 │  │  brain runtime ─ triggers ─ resources   │  │           │
 │  └───┬───────────────┬──────────────┬──────┘  │           │
 └──────┼───────────────┼──────────────┼─────────┘           │
        │ launch        │ host git     │ read/write          │
        ▼               ▼              ▼                     ▼
 ┌─────────────┐  ┌───────────┐  ┌────────────┐      ┌──────────────┐
 │ host bridge │  │ primary   │  │ $MFW_HOME  │      │ board folder │
 │ egress proxy│  │ repository│  │ .mfw/mfw.db│      │ (markdown)   │
 └──────┬──────┘  └─────▲─────┘  └────────────┘      └──────────────┘
        │ pipes, socket │ validated bundle
 ┌──────▼───────────────┴──────────────────────────┐
 │ bwrap sandbox (one per run)                     │
 │  agent CLI · private clone · synthetic home     │
 │  no host network · seccomp · systemd scope      │
 └─────────────────────────────────────────────────┘
```

| Package | Role |
| --- | --- |
| `packages/board-core` | the board engine as a library: documents, locks, validation, workflow |
| `packages/board` | `mfw-board`, the board CLI, and the agent skill |
| `packages/core` | shared types and task-graph logic |
| `packages/db` | schema, migrations and the event log |
| `packages/daemon` | scheduling, runs, containment, verification, merging, the brain, auth, resources |
| `packages/api` | the typed API and the scope of every procedure |
| `packages/mcp` | the MCP server, run as `mfw mcp` |
| `packages/cli` | `mfw`, the dispatcher |
| `packages/plugin-api` | contracts for the built-in resources, targets and harnesses |
| `apps/start` | the server entry, request guards and web UI |

Inside `packages/daemon/src`:

| Directory | Holds |
| --- | --- |
| `packages/daemon/src/containment` | sandbox profiles, the `bwrap` compiler, probe, attestation, launch, egress, execution pins |
| `packages/daemon/src/host-git` | hardened host git: import, landing repository, push, config allowlist |
| `packages/daemon/src/run-workspace` | private clones, verifier clones, in-sandbox work-in-progress snapshots |
| `packages/daemon/src/finalize` | the crash-resumable state machine that closes a run |
| `packages/daemon/src/brain-runtime` | the brain: turns, decision rights, provenance, chat |
| `packages/daemon/src/resources` | resource pools, leases, holds and the machine ledger |
| `packages/daemon/src/triggers` | events, arming and trigger actions |
| `packages/daemon/src/auth` | owner sign-in, sessions and scoped tokens |

## Data flow

1. **Intent.** The owner gives a direction on Lead, or a task is written to the
   board. The brain turns direction into tasks through validated tools.
2. **Dispatch.** The scheduler picks ready tasks in dependency order. Admission
   checks resources, budgets, holds and the sandbox preflight.
3. **Run.** The engine seeds a private clone and launches the agent through the
   launch chain below.
4. **Import.** After the agent's processes are dead, a helper in the sandbox bundles
   its commits. The host validates the bundle and stores it under a quarantine ref.
5. **Verify.** The task's checks run on that commit in a disposable sandbox.
6. **Merge.** The queue lands the verified commit from a host-owned repository, or
   holds it on an owner card if it touches a host-executed path. It then pushes,
   unless `pushOnMerge` is off.
7. **Report.** Host-written events feed the board, inbox and Lead. Only
   host-observed facts can render as "verified" or "merged".

## The launch chain

Every sandboxed run kind goes through one path, in
`packages/daemon/src/containment/agent-launch.ts`:

```
 preflight          refuse early, with the fix (config, tools, dev environment)
    │
 compile            SandboxProfile ──► bwrap options, seccomp, pinned binds
    │
 probe              runs inside that sandbox, checks 24 real outcomes
    │
 attestation        append-only record of the result
    │
 authorization      newest, passing, recent, same sandbox ──► single-use token
    │
 launch             launchSandbox spawns the agent, inside a systemd scope
```

A failure at any step refuses the launch. No step falls back to an unsandboxed
run. An interactive launch skips the attestation but cannot carry autonomy flags.

The host processes around it (driver, bridge, launcher, egress proxy) are, from
a checkout, scripts run by bun; from a production build, its hash-checked built
copies; and from a compiled install, `mfw __host <id>`, the install's own `mfw`
re-executing itself ([install.md](install.md)).

Each role gets its own profile
(`packages/daemon/src/containment/role-profiles.ts`):

| Role | Workspace | Network |
| --- | --- | --- |
| task, repair | private clone, writable | per-run proxy |
| verifier, merge-verify | disposable clone of one commit, writable tree, read-only gitdir | none |
| reviewer, plan, import, trigger agent | read-only | per-run proxy |
| brain | read-only | per-run proxy, plus its own socket |

## The run lifecycle

```
 ready ─► claimed ─► preflight ─► launch ─► running ─► agent exits
                        │            │         │            │
                     refused      refused   steer/stop      ▼
                                                        finalize
                                                            │
  classify ─► reap leftovers ─► ingest report ─► verify ─► critic (optional)
                                                            │
                         ┌──────────────────────────────────┤
                         ▼                                  ▼
                  enqueue merge                          settle
                         │                       (the brain decides what
              merge, or ask-first card            happens to a failed or
                         │                          questioned run)
                       push
```

- Agents run in detached tmux sessions, so a server restart does not stop them. The
  supervisor adopts them again at boot.
- Finalization is journaled (`packages/daemon/src/finalize/machine.ts`). A crash
  resumes at the step it reached.
- Failed runs are not retried by fixed policy. They settle and wake the brain,
  within its action caps and the act breaker.

## Where state lives

| Path | Contents |
| --- | --- |
| `$MFW_HOME` (default `~/.local/share/mfw`) | never visible to a sandbox, except the fleet directories below |
| `$MFW_HOME/config.json` | machine and per-project settings |
| `$MFW_HOME/auth.db` | owner, sessions, token hashes and token audit |
| `$MFW_HOME/credentials.json` | provider API keys and trigger secrets (0600) |
| `$MFW_HOME/setup-token`, `mcp-token` | first-run token, optional MCP token (0600) |
| `$MFW_HOME/host/host.db` | machine-wide resources, leases and usage ledger |
| `$MFW_HOME/triggers/` | arming records, outside every repository |
| `$MFW_HOME/landing/` | host-owned repositories for merges and pushes |
| `$MFW_HOME/workspaces/` | per-run private clones |
| `$MFW_HOME/agents/{claude,codex}` | fleet CLI logins, bound into sandboxes mostly read-only |
| `<project>/.mfw/mfw.db` | runs, events, decisions, attestations and evidence |
| `<project>/.mfw/runs/<id>/` | one run: host-only files, read-only `control/`, agent-writable `outbox/` |
| the board folder | tasks, specs and decisions as markdown; SQLite is a deletable index |
| `$XDG_RUNTIME_DIR/mfw` | per-run proxy and brain sockets (private, per user) |
