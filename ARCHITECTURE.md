# mfw architecture

This document describes how mfw is built today. It is written from the code;
where a behaviour is a default, the default is stated. For installing and
running mfw see [`README.md`](./README.md); for the board CLI see
[`packages/board/README.md`](./packages/board/README.md).

## 1. What mfw is

mfw is a local orchestrator for coding agents. You describe work as markdown
tasks that depend on each other. mfw runs the ready ones, each in its own git
worktree, in parallel, up to a limit. It checks every result against that
task's Definition of Done (DoD), merges verified work into your integration
branch, and records everything it did. It runs on your machine, against your
repositories, with the agent CLIs you have installed (Claude Code and Codex are
the two it can drive end to end).

The problem it addresses: a single agent session loses its place over a long
project, and several sessions on one checkout collide. mfw splits the
project into a dependency graph of small tasks, isolates each run, and decides
"done" with commands rather than with the agent's own report.

### Principles

- **Files are the record.** The board is folders of markdown in the project's
  git repository. SQLite holds runtime bookkeeping and an audit log, and can be
  deleted without losing the board.
- **Deterministic code decides; the model advises.** Dependency resolution,
  scheduling, admission, retries, merging and recurrence are plain code. A model
  is consulted only where there is no computable answer (diagnosing an
  ambiguous failure, reviewing a change, choosing among ready tasks), its output
  is a validated structured result, and every failure of the model path falls
  back to a human gate rather than to approval.
- **Never trust the transcript.** A task is done when its checks pass in the
  worktree, not when the agent says so.
- **Survive restarts.** Agent runs live outside the daemon process; every
  multi-step operation is journaled and resumable.
- **Fail closed.** Unknown resource requirements, a failed sparse checkout, a
  model error, or a suspicious board scan stop work instead of letting it
  proceed.
- **Nothing spends money by itself.** Dispatch is off until an operator turns
  it on.

## 2. Layers

```
+--------------------------------------------------------------------+
| UI / API         apps/start (TanStack Start, React)                |
|                  @mfw/api (tRPC)        @mfw/mcp (MCP server)      |
+--------------------------------------------------------------------+
| Service          @mfw/daemon  orchestrator library                 |
|                  scheduler, worktrees, runs in tmux, verification, |
|                  finalization, merge queue, supervisor, triggers,  |
|                  brain, host resources, RunPod target              |
|                  @mfw/db (libSQL + Drizzle)   @mfw/core (shared)   |
+--------------------------------------------------------------------+
| Board            @mfw/board-core  generic markdown-document engine |
|                  @mfw/board       mfwb CLI + agent skill           |
|                  files on disk: <project>/.mfw/{board.yaml,tasks,..}|
+--------------------------------------------------------------------+
```

Dependencies point downward only. The board layer knows nothing about git
worktrees, agents or SQLite, and works without a daemon.

### Process model

Today the service and the UI run as **one process**. `apps/start` is a
TanStack Start server (Nitro, Bun preset). A Nitro plugin
(`apps/start/src/server/boot.ts`) calls `boot()` from `@mfw/daemon` when the
server starts, holds the resulting orchestrator on `globalThis`, and the tRPC
route handler uses that same instance. There is no separate headless binary
and no daemon-only entry point. `MFW_DISABLE_ORCHESTRATOR=1` serves the UI
without attaching any project. Stopping the server detaches from running
agents; it does not kill them.

State is addressed in two places:

- `<project>/.mfw/` per project: the board, the project database, run
  directories, worktrees' bookkeeping.
- `$MFW_HOME` (default `~/.local/share/mfw`): `config.json` (projects and
  machine settings), `credentials.json` (mode 0600), trigger arming records,
  host-resource state (`host/host.db`), RunPod account state, and a machine-wide
  `daemon.lock`.

## 3. Board layer

### `@mfw/board-core`

A library, with no binary. It reads and writes **documents** described by a
`board.yaml`:

- A document is a markdown file with YAML frontmatter (`mfw: 1`, `id`, `rev`,
  plus the fields its type declares) and a body. A type is either `flat`
  (`<dir>/<ID>-<slug>.md`) or `directory` (`<dir>/<ID>-<slug>/` with a primary
  file and declared siblings). A document's type is decided by where it lives.
- `board.yaml` declares types, fields and id schemes. Field kinds are enum,
  reference (to a type, several types, or any; optionally a list, optionally
  `acyclic`), scalar (`string`, `number`, `boolean`, `date`, `json`, with an
  optional pattern) and checklist.
- **Ids** are always `<KEY>-<number>` (for example `MFW-12`; a type can add a
  suffix such as `MFW-ADR-3`). They are permanent. Types may share one number
  sequence. Allocation is checked against the highest id actually on the board,
  so restoring an old board cannot reissue an id.
- **Concurrency.** Every write is read-modify-write under a per-document lock
  (kernel `flock` on a stable lock file, so a crashed holder releases it) and
  lands through write-temp, fsync, rename, fsync-directory, so a reader never
  sees a torn file. `rev` increments on each write and callers may pass a base
  revision to detect a concurrent change. The engine keeps no cache: every call
  re-reads what it needs.
- **Validation** covers schema, ids, references, hierarchy, dependency cycles
  and file-scope globs. Invalid documents are reported, not silently dropped.
- **Workflow** (opt-in per type): status classes (`terminal`, `live`, `parked`,
  `queued`), a `ready` rule (a document is ready when its status is queued and
  every `depends_on` entry and every hierarchy child is finished), and
  `transitions`, each of which becomes a verb (`start`, `done`, ...) that checks
  its source status atomically under the lock.
- **Hierarchy** (opt-in): `parent` / `children` kept in sync on every write,
  a maximum depth, and rules that say which documents may sit under which,
  matched on a type and on field values (for example, a task whose `kind` is
  `subtask` only under a `task`).
- **File scopes** (opt-in, field named by `ownership`): documents declare glob
  patterns for the files they will touch. The engine detects overlap, with an
  exemptions file for deliberate sharing (append-only globs, or named pairs of
  documents).
- **Scheduling views**: `graph` (dependency graph as Mermaid, DOT or JSON),
  `levels` (longest dependency chain below each document), `plan` (a
  conflict-free batch of ready documents, ranked by how much each unblocks,
  skipping any whose file scope overlaps work in progress), and `conflicts`.

### `@mfw/board` and `mfwb`

`mfwb` is the only board CLI. It exposes the engine: `list`, `show`,
`create`, `update`, list/number/boolean field operations, checklists, `note`,
`reparent`, `repair`, `validate`, `ready`, `levels`, `graph`, `plan`,
`conflicts`, the config-declared transition verbs, `claim` / `release`, and
`skill install`. It finds `board.yaml` by walking up from the current
directory (`board.yaml`, then `.mfw/board.yaml`), or from `--config` /
`MFW_BOARD`. It needs no daemon and is safe to run beside one: both take the
same per-document locks.

`claim` binds a task to a run id and a worktree under one lock, after
checking that dependencies are finished and that its file scope does not
overlap any currently claimed task. It does not change status; the binding
lives in a sidecar `.mfw/state/tasks/<ID>.json`. `release` removes it, and a
transition into a finished or parked status releases it too. `@mfw/board` also ships the
agent skill (`packages/board/skill/SKILL.md`), installed with
`mfwb skill install` for Claude, Codex, OpenCode or Pi.

### The project board

A project attached to mfw gets a default `.mfw/board.yaml` if it has none. It
declares two types:

- `task`: a directory `.mfw/tasks/<ID>-<slug>/` holding `task.md`, an optional
  `spec.md`, and an optional `files/` directory of attachments. Status is a
  frontmatter field with the values `draft`, `backlog`, `ready`, `in_progress`,
  `blocked`, `review`, `done`, `archived`. The directory name is fixed at
  creation and does not change with status. Other fields include `type`
  (`implementation`, `spike`, `epic`, `maintenance`), `priority`, `size`,
  `depends_on`, `parent`, `owns` (file scope), `requires_resources`,
  `execution_target`, `require_review`, `reopen_when`, and `verification` (the
  DoD, a structured field because the daemon executes it).
- `adr`: `.mfw/adrs/<KEY>-ADR-<n>-<slug>.md`, statuses `proposed`, `accepted`,
  `superseded`, `rejected`.

Everything an agent could use to change policy lives elsewhere (see section 9):
`.mfw/AGENTS.md` (rules every run is told to follow), `.mfw/config.yaml`,
`.mfw/lifetime/` (recurring task definitions) and `.mfw/triggers/`.
The board can also live in a different checkout from the code
(`boardRoot` in the project config); worktrees, runs and the database stay with
the code repository.

### How the daemon uses the board

The daemon builds an in-memory index over `@mfw/board-core` and adds what the
stateless engine leaves to its caller:

- **External-edit detection.** On every supervisor pass it re-reads and hashes
  each task file and compares with the hash it last saw. Any difference, or a
  vanished file, triggers a full reload rather than a partial patch. Hashing is
  used because file watchers proved unreliable in the bundled server and
  mtime-plus-size misses same-length edits.
- **Circuit breaker.** A scan that would drop at least half the indexed tasks
  at once (or finds the tasks directory missing) puts the board in a suspended
  state: dispatch pauses and the git layer refuses to commit, so a bad checkout
  or `git reset --hard` cannot be made permanent. Deliberate deletion goes
  through an explicit `wipe()` that declares itself for its duration. There is
  no setting to disable the breaker.
- **Runtime sidecars.** Counters that would make a task file churn (attempts,
  stalls, resumes, the preserved-worktree pointer, draft-expansion state) are
  kept in `.mfw/state/tasks/<ID>.run.json`, next to the claim sidecar.
- **Committing.** `BoardRepo` commits `.mfw/tasks`, `.mfw/adrs` and
  `.mfw/board.yaml` on the integration branch, debounced (3 seconds minimum
  between commits) and path-scoped (`git commit -- <paths>`), so your staged and
  unstaged work is untouched. It refuses to commit when HEAD is not the
  integration branch, when a merge, rebase, cherry-pick, revert or bisect is in
  progress, or when the breaker has tripped. A project that is not a git repo,
  or that ignores the board, still works unversioned.

## 4. Service layer

`@mfw/daemon` is a library; `boot()` is its composition root. Per attached
project it builds one set of services and starts two loops, a **supervisor**
(always on) and a **scheduler** (off until enabled). A project takes a kernel
lock on `.mfw/daemon.lock`; a second orchestrator on the same project fails to
start. A machine-wide lock in `$MFW_HOME` does the same for the home directory.

| Component | Role |
| --- | --- |
| `scheduler.ts` | The only dispatcher: gates, ready set, caps, admission, start |
| `run-engine.ts`, `agent-host.ts` | Create the worktree and run record, launch the agent driver in tmux |
| `agents/` | Provider catalogue, drivers and bridges for Claude Code and Codex, event normalization |
| `supervisor.ts` | Observe live runs, enforce limits, drive finalization, merge queue, triggers, board polling |
| `finalize/` | Pure state machine plus a journaled step runner |
| `verifier.ts` | Run DoD checks in a scrubbed environment |
| `merge-queue.ts` | Serialized merge into the integration branch |
| `maintenance.ts` | Regression sweep, groom, worktree and run-directory garbage collection |
| `brain.ts`, `review.ts` | Advisory model decisions; the human review payload |
| `triggers/`, `lifetime.ts` | Event/cron-driven actions; recurring tasks |
| `host-resources/` | Machine-wide capacity accounting |
| `runpod-*.ts`, `remote-*.ts` | Optional RunPod execution target |
| `task-service.ts`, `tasks/` | The board index, claims, leases, readiness |

### Scheduling

The scheduler loop is a sequential `while` (a slow tick cannot overlap
itself). Each tick:

1. **Gates.** Nothing starts if dispatch is paused machine-wide or for the
   project, the board is suspended, a persisted hold is active (for example after
   a provider rate limit), or main is red (below).
2. **Promote.** A `backlog` task moves to `ready` automatically when it has a
   body or acceptance criteria, all `depends_on` tasks are `done`, and its
   type's template sections are present. Tasks with `ready_mode: manual` are
   skipped. Parked tasks with satisfied `reopen_when` conditions reopen here.
3. **Ready set.** `ready` status, no claim held, every dependency `done`.
4. **Cap.** `maxConcurrent` (default 2) is an absolute ceiling on live runs.
5. **File-scope hold.** A task whose declared `owns` globs overlap a running
   task, or one chosen earlier in the same wave, is held. Overlap that was not
   declared is not prevented; it is resolved at merge time.
6. **Resources.** Declared `requires_resources` must all be reservable or the
   task is held (section 7).
7. **Order.** Priority, then task number. When several tasks are ready and a
   model is configured, the brain may choose a subset and order, but it can only
   narrow the set: it cannot add an ineligible task, exceed the cap or bypass a
   resource hold. Without a model, ordering is deterministic.
8. **Start.** `RunEngine.startTask` claims the task and launches the run.

Maintenance (groom, reopen-by-command, draft expansion, garbage collection and
the regression sweep) runs before the gates, because the sweep is what clears a
red main.

### Runs

Every run is a detached **tmux** session on a dedicated socket (`tmux -L mfw`)
plus a run directory `<project>/.mfw/runs/<ulid>/` holding `meta.json`, the
normalized event transcript `events.jsonl`, raw pane output, an `exit` record,
and steer/control channels. The daemon attaches to observe and control; it does
not own the process, so runs survive a daemon restart and can be killed as a
process tree.

A run has a **kind**: `task`, `repair`, `plan`, `import`, `action` or `brain`.
Task and repair runs get a worktree; they are the only kinds that produce
mergeable code. A run's state progresses `starting`, `running`, `ended`,
`finalizing`, `merging`, then a terminal state (`completed`, `failed`,
`killed`, `interrupted`, `rate_limited`, `needs_review`, `finalize_error`).

Each run executes in its own git worktree at `<repo>/worktrees/<runId>` on a
branch `mfw/<runId>`, created from the integration branch's current commit.
The worktree is created without a checkout and then sparse-restricted so the
board and every other `.mfw/` path (except `.mfw/triggers/`) is never on disk
(section 9). Per-worktree git config records the owning run, branch and base
commit as provenance. After a run, a clean worktree is removed; one with
uncommitted or unmerged work, including ignored files, is preserved for a human.

Agent drivers speak structured protocols (Claude Code stream-json, Codex
app-server) and normalize them to one event format, which is what the UI shows.
Where the driver verifies it drains the steer channel, the UI can steer or stop
a run mid-flight.

### Supervisor

One awaited loop (default every 2 seconds). Each pass: observe live runs and
renew their leases; enforce the watchdog (kill after 5 minutes without new
output or 45 minutes wall time by default; a maximum turn count is optional);
advance finalization for every run whose session has ended; drain the merge
queue; poll the board for outside edits and commit pending board changes;
dispatch triggers; and every Nth pass run maintenance.

Merging and triggers are on the supervisor rather than the scheduler on
purpose: a project with dispatch switched off must still merge work that was
already verified and still notify when main goes red.

**Reconciliation at boot** compares live run rows with the tmux sessions that
exist: runs whose session is alive are adopted; runs whose session exited are
finalized from their exit record; sessions with no run row are killed; runs that
vanished without an exit record are marked `interrupted`; stale claims are
cleared. Remote runs are re-observed through their target; an uncertain
observation keeps the run and its capacity rather than guessing.

## 5. Task lifecycle

```
 create          promote           claim            run
 draft/backlog -> ready ----------> in_progress ----> agent works in worktree
    ^                |                                      |
    | replan         | (scheduler: gates, caps, scope)      v
    |                                                  finalize (journaled)
    |                                                   classify, ingest report,
    |                                                   follow-ups
    |                                                        |
    |                                                        v
    |                                                  verify DoD
    |                                          pass /               \ fail
    |                                            v                    v
    |                                  critic / review gate    stall++, then repair
    |                                   (if enabled)           run, replan or blocked
    |                                         |
    |                                         v
    |                                   merge queue --> done
    +------------------ blocked / review <-- park on unresolved conflict
```

1. **Create.** A task is created from the UI, MCP, `mfwb`, a planner run, an
   import, a trigger or a recurring definition. A one-line capture becomes a
   `draft`; an expansion run turns it into a specified task (bounded retries).
   A goal can be given to a **plan** run, which proposes a task DAG and may
   raise clarifying questions that a human answers in the inbox.
2. **Ready.** Promotion rules in section 4.
3. **Claim and start.** Under the board lock and a `claim` lock that spans the
   whole decide-then-write step (so two tasks claimed at once cannot both miss
   each other's file scope), the task is bound to a new run id with a lease. The
   worktree is created, the driver starts in tmux, status becomes `in_progress`.
   An agent that hits a missing dependency can write `MFW_REPORT.json` in its
   worktree to declare itself blocked, ask for a replan, drop the task, or
   propose follow-up and sub-tasks.
4. **Finalize.** When the session ends, a pure transition table
   (`finalize/machine.ts`) chooses the next step from the run's outcome and the
   facts gathered so far; the step runner executes it and journals the result in
   `run_steps`. A crash resumes by rebuilding context from the journal.
   Steps include: classify the exit, reap leftover processes, ingest the report,
   create follow-ups, verify, critic, enqueue merge, release the task, notify,
   clean up the worktree.
5. **Verify.** The effective verification is the project's `mergeChecks`
   followed by the task's own `verification` checks, de-duplicated; a task can
   add checks but never remove project policy. A check is `run` (command and
   expected exit code), `files_exist`, or `diff_against_base` (the tree must have
   changed). The default project policy is a single `diff_against_base`. Checks
   run in the run worktree, behind the operator-declared `checkPrefix` (for
   example `direnv exec .` or `nix develop -c`), in a scrubbed environment
   (an allowlist, configurable per project), with a per-check timeout and
   output cap. A task with no checks and a failed agent goes back to `ready`.
6. **Failure handling.** A failed check increments the task's stall count. If
   attempts remain (`maxRepairs`, default 2) a repair run starts in the same
   worktree, or the brain chooses resume, retry, replan, split or abandon. When
   `maxStalls` (default 3) is reached, or the model path fails, the task goes to
   `blocked` and an inbox item is raised. A check process that dies to a signal
   is classified as infrastructure, not as a regression: the task returns to
   `ready` with its worktree kept, no stall is counted. Provider rate limits
   hold dispatch and return the task to `ready` without using an attempt. A
   watchdog kill counts as a stall. An interrupted run may be resumed in a child
   run (`maxResumes`, default 2).
7. **Review.** Work goes to `review` instead of merging if the task sets
   `require_review`, if the project's `changeReview` is `human`, or if the
   assisted critic flags the change or fails. The review view shows the diff,
   DoD results, the critic's verdict, cost and the agent's own report. Approving
   enqueues the merge; rejecting starts a repair run whose prompt carries the reviewer's feedback.
8. **Merge.** Section 6. On success the task becomes `done`.
9. **Reopen.** A parked task can declare `reopen_when` conditions: `task_done`
   predicates are checked every tick; command predicates are inert until an
   operator arms the exact conditions outside the repository
   (`tools/reopen-policy.ts`), run at most once per ten minutes and only while
   dispatch is on.

## 6. Merge queue and main

One FIFO worker per project, one job in flight, merges into the **recorded**
integration branch (resolved when the project is attached if not configured;
never "whatever is checked out"). It works in a persistent detached worktree at
`.mfw/integration/`; the primary checkout is never switched, branched or reset.
Steps for a job:

1. `git merge --no-ff` the run branch in the integration worktree.
2. Restore every protected `.mfw/` path from the merge base (section 9) and
   amend the merge commit, emitting `merge.board_reverted` if the agent had
   changed any.
3. Move the branch ref with a compare-and-swap `update-ref`. If the primary
   checkout is on that branch and cannot fast-forward, the merge reports that
   instead of forcing it.
4. Run the post-merge tail (task to `done`), then, if `pushOnMerge` is on
   (default) and a remote exists, push. A failed push never undoes the merge.

On a conflict the run branch is rebased, the DoD is re-run, and the merge is
retried once. A second failure **parks** the job. Parked jobs are retried
automatically on the maintenance cadence up to three times, since a park is
usually a stale conflict; after that a session brief is raised and a human can
retry, abandon or send the task back to `ready`. With `conflictResolution:
assisted`, an exhausted conflict first gets an agent run in the existing
worktree, and the result re-enters the queue and the DoD gate.

Every job state change commits before the next action; on restart in-flight
jobs are reset to queued after the integration worktree is hard-reset.

### Red main

The **regression sweep** (maintenance) runs the project's `mergeChecks` in a
throwaway detached checkout of the integration tip (`.mfw/sweep/`), using a
hard-linked snapshot of installed dependencies. It is the only thing that sets
or clears `main_red`. Failures are classified from the outcome (signal,
timeout, exit code), not from the command text. A failure that also fails at
the last known-green commit is an environment problem and does not trip the
breaker. An unplaced failure may get an advisory model opinion; without one it
counts as a regression.

While main is red the scheduler starts nothing and the merge queue pauses
(jobs stay queued). The one exemption is the task the sweep names as the cause:
with `selfRepairMainRed` (default on) it may run to fix the breakage. This is
bounded: after three sweeps without a clear, self-repair is turned off and a
human is asked.

## 7. Resources, targets and recovery of capacity

- **Project semaphores.** A bare string in `requires_resources` is a one-slot
  semaphore private to the project, acquired all-or-nothing with the run
  (`resource_slots`).
- **Host resources.** Machine facts (RAM, CPU permits, GPUs) are managed by one
  `HostResourceCoordinator` per daemon, backed by `$MFW_HOME/host/host.db`
  (SQLite WAL) and covering every attached project. Requirements are explicit
  (`{scope: host, id: ram, amount: 8GiB}`); unknown, malformed, disabled or stale
  requirements fail closed. Probes only constrain configured capacity, they do
  not invent it. RAM admission combines configured capacity, headroom, a fresh
  `MemAvailable` sample and memory promised to runs not yet resident. GPUs are
  exclusive slots bound to device ids; a GPU held by a process mfw does not own
  is observed, never signalled. Admission is a durable saga (waiter, provisional
  grant, claim, project slots, activate with a fencing token, launch, or
  compensate in reverse) and waiters are served FIFO. Expiry alone never frees
  capacity: recovery adopts live processes and reclaims only on proven absence
  or a changed kernel boot id.
- **RunPod (optional).** A task may set `execution_target: runpod`. This is a
  target of the same run engine, not a second engine: claims, run records,
  verification, finalization and merging are unchanged. One account service
  holds credentials, policy, live inventory, leases, cost and audit in
  `$MFW_HOME/runpod/<account>/account.db`. Policy (price, runtime, per-run spend,
  account burn) is enforced in code; projects can only narrow it. Every provider
  call has an idempotency id recorded first; termination is mandatory on every
  exit path and complete only after a fresh listing shows the pod gone; startup
  recovery adopts pods it provably owns and never deletes by name alone. Host
  GPU/RAM/CPU requirements on a RunPod task are rejected, not ignored.
- **Execution environment.** Secrets reach a run only as named workload grants
  (`workload_secret_grants`), disjoint from ordinary environment names.

## 8. Triggers, recurring tasks, decisions

**Triggers** (`.mfw/triggers/<id>.md`) run an action when a project event
occurs or on a cron schedule. Actions: `notify`, `script`, `agent`,
`create_task`. A definition is reviewable in a diff and travels with the repo,
but it is **inert until armed**: arming writes a record, including the
definition's sha256, to `$MFW_HOME/triggers/<project>.json`, outside every
repository. If the file's hash stops matching, the trigger disarms itself and
raises an inbox item. Delivery is at-least-once from a durable per-trigger
cursor in the event log: the cursor advances only after the action reaches a
terminal state, so a crash repeats an action rather than skipping it. Each
dispatch carries a stable delivery id (`MFW_DELIVERY_ID`) so the action can be
idempotent; mfw does not deduplicate on it. On first arm the cursor starts at
the current head, never at zero. Catch-up after downtime is `latest` (default),
`all` (capped at 50) or `none`. A trigger that keeps failing is marked dead
after its retry budget so it cannot wedge its cursor; `on_failure:
hold_dispatch` optionally pauses dispatch. Script actions have their own
semaphore (`maxConcurrentTriggers`, default 2); agent actions count against
`maxConcurrent`.

**Recurring tasks** (`.mfw/lifetime/<id>.md`) carry a cron schedule or a
condition; firing state is durable, so a definition due during downtime fires
on the next tick, and a fired definition creates an ordinary `backlog` task.

**The brain** is `BrainService`. Each call is a durable run of kind `brain`
(prompt and output on disk, a `decisions` row, a hard timeout, abortable) whose
result is a validated structure. It is used for: the critic (change review),
replan decisions after a failed verification, import review, diagnosis of
sweep failures nothing else could classify, wave selection in the scheduler, and
conflict resolution. Each use is governed by the project's `assistance`
settings (`failureDiagnosis`: `assisted` or `escalate`; `conflictResolution`:
`assisted` or `escalate`; `changeReview`: `off`, `assisted` or `human`; the
default for `changeReview` is `off`). A model failure never approves anything.
Hard contention is declared (`requires_resources`, `owns`), not inferred by the
model.

**Escalation.** When recovery is exhausted (a parked merge, a persistent red
main, a task sent to `blocked`) mfw composes what it knows into a stored
session brief and raises an inbox item; it costs nothing until a human opens
it.

## 9. Security model

mfw runs agents that execute arbitrary commands. Be clear about what is and is
not contained.

**Not isolated.**
- Agents run as your user, with your permissions, on your machine. In the
  default autonomous mode Claude Code is started with
  `--dangerously-skip-permissions` and Codex with approvals set to never;
  `approvalMode: interactive` is a per-project alternative.
- A git worktree isolates ordinary checkout writes. It is not a shell sandbox.
- The tRPC API and UI have **no authentication**. Anyone who can reach the port
  can create tasks, start runs and change settings. Access control is
  entirely a matter of where the listener binds and what sits in front of it.
- Verification commands come from task files and run as your user in the
  worktree, with a scrubbed environment but no filesystem isolation unless you
  configure a wrapper via `checkPrefix`.

**Network exposure.** The server listens on `PORT` (default 7777) and `HOST`
(Nitro's own default if unset). The systemd unit in `packaging/mfw.service` sets
`HOST=127.0.0.1`. The home-manager module binds the machine's tailnet address
only and refuses to start without one. Do not bind `0.0.0.0` on an untrusted
network. To reach it remotely, keep the listener on loopback and publish it
through a proxy that authenticates (for example `tailscale serve`).

**Optional filesystem isolation.** With `agentIsolation: "bwrap"`, agent runs
are wrapped in bubblewrap: the host filesystem read-only, `$HOME`, `/tmp`, the
worktree and the run directory writable, and `$MFW_HOME` masked with an empty
tmpfs so a confused agent cannot read credentials or arming records. Network
stays shared. The default is `none`, and a missing `bwrap` degrades to
unsandboxed with a log warning. The agent runs as the same uid as the daemon,
so this stops casual access, not a deliberate escape.

**What mfw does enforce.**
- *The board is not agent-writable.* Run worktrees are created with
  non-cone sparse checkout that excludes all of `.mfw/` except
  `.mfw/triggers/`. If sparse setup fails the run does not start. `AGENTS.md`
  is copied in as a plain file so the agent can read its rules but cannot stage
  an edit to them. The merge queue then restores every protected `.mfw/` path
  from the merge base as a second line of defence; the protected set is
  default-deny, discovered from the union of the base and merged trees, so new
  mfw paths are protected automatically. The board committer stages a narrower
  path list than this, so it never adds the database or runs.
- *Triggers cannot be introduced by an agent.* A trigger file an agent merges is
  inert until an operator arms its exact hash outside the repository.
- *Secrets stay out of the repo and the database.* Provider keys live in
  `$MFW_HOME/credentials.json` (mode 0600, atomic writes); RunPod credentials come only from that store,
  and secret values granted to a run are redacted from captured output.
- *Repository hygiene.* mfw maintains a marked block in `.git/info/exclude` for
  its runtime paths and never edits `.gitignore`.
- *Bounded spend.* Dispatch is off at boot, a machine-wide master stop exists,
  concurrency is capped, retries and resumes are bounded, and RunPod has hard
  price and burn limits.

## 10. Persistence

| Where | Holds | If deleted |
| --- | --- | --- |
| `<project>/.mfw/board.yaml`, `tasks/`, `adrs/` | The board | Real loss (it is in git) |
| `<project>/.mfw/state/` | Claims, counters, id floor, project identity | Rebuilt or reset; claims lapse |
| `<project>/.mfw/mfw.db` (libSQL, Drizzle) | Runs, finalization journal, merge queue, audit event log, review comments, decisions, clarifications, trigger cursors, dispatch admissions, scheduler flags | Board intact; run history and in-flight bookkeeping are lost |
| `<project>/.mfw/runs/<ulid>/` | Transcripts and run files | History lost; live runs cannot be adopted |
| `$MFW_HOME/config.json` | Projects and machine settings | Projects must be re-added |
| `$MFW_HOME/credentials.json`, `triggers/`, `host/`, `runpod/` | Secrets, arming, host and account state | Re-enter, re-arm |

The audit log is append-only per project (typed events appended in the same
transaction as the state change, then fanned out on an in-process bus after
commit, with retention pruning). It feeds the live UI channel, the history
view and triggers. The live channel is server-sent events with a 5-second
keepalive so it fits under proxy idle timeouts; a reconnect backfills at most
500 events, beyond which the client refetches.

## 11. UI, API and MCP

`apps/start` is a TanStack Start app mounted under a `/mfw/` base path (a
build-time Vite setting, `MFW_BASE_PATH`). Screens: Now, Inbox, History,
Settings (projects, providers, appearance), and per project: Board (kanban),
Task, Review, Runs and run transcript (live, with steer and stop), Files, ADRs,
Triggers, Project settings, plus machine-wide Resources, RunPod and OpenRouter
account views. There is no dependency-graph screen; the graph is available as
`mfwb graph`, as `tasks.graph` in the API and as the MCP `graph` tool.

`@mfw/api` is a tRPC router (Zod-validated, superjson) over the orchestrator,
with routers for tasks, ADRs, runs, review, inbox, system, live events, host
resources, clarifications, files, resources, RunPod, OpenRouter, settings,
triggers and sessions.

`@mfw/mcp` is a stdio MCP server that calls the same tRPC API (at `MFW_URL`),
so an agent edits tasks through the running service rather than a second
source of truth. Tools: `list_tasks`, `get_task`, `graph`, `create_task`,
`edit_task`, `move_task`, `inbox`, `task_trace`, `health`, `list_runs`,
`run_entries`.

## 12. Packages

| Package | Purpose |
| --- | --- |
| `@mfw/board-core` | Generic markdown-document engine (library) |
| `@mfw/board` | `mfwb` CLI, claim semantics, agent skill |
| `@mfw/core` | Shared domain: enums, dependency-graph helpers, event schemas, task template parsing |
| `@mfw/db` | libSQL client, Drizzle schema and migrations, event log |
| `@mfw/daemon` | Orchestrator library |
| `@mfw/api` | tRPC router |
| `@mfw/mcp` | MCP server |
| `apps/start` | The web app that boots the orchestrator and serves UI and API |
| `packaging/` | systemd user unit and home-manager module |

Runtime requirements: Bun, git, tmux; `bwrap` optionally.
