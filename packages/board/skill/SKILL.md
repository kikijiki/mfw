---
name: mfwb
description: "Operate a markdown board (tasks, specs, ADRs, any config-defined document types) from the terminal with mfwb, no daemon required. Use when the user asks to list, show, create, update or validate documents, find what is ready to work on, start/finish/defer a task (config-declared transitions), edit list fields or checklists, manage parent/child hierarchy, claim a task for a worktree, or install this skill. Do not edit board files by hand with Read/Edit/Write - mfwb goes through the real lock + validation path those tools skip."
---

# mfwb: the board CLI

A plain CLI over the same `@mfw/board`/`@mfw/board-core` store the daemon
uses - same locks, same validation, same files. It needs no daemon running;
it's also perfectly safe to run **while** the daemon is attached to the same
project, since both go through the same per-document and named locks.

Typical flow on a board with workflow config: `mfwb ready` (what can start) ->
optionally `mfwb claim <id>` (bind it to your worktree) -> `mfwb start <id>` ->
`mfwb note` / `mfwb check` as you work -> `mfwb done <id> "<outcome>"`.

## Are you inside an agent run's worktree right now?

**If you are an agent executing a task dispatched by mfw itself, stop - this
skill is not for you.** `.mfw/tasks/` and `.mfw/adrs/` are deliberately not in
your sparse-checked-out worktree, `mfwb` will fail to even find a board
there, and if it somehow succeeded, mfw discards board edits made from a task
branch before merging (see your `.mfw/AGENTS.md`). Report via `MFW_REPORT.json`
instead. This skill is for a human, or an assistant working in the main
checkout (or a separate docs checkout), operating the board directly.

## Finding the board

Gitignore-style: starting at `$PWD` and then each parent up to `/`, `mfwb`
checks for `board.yaml`, then `.mfw/board.yaml`; the first directory with a hit
wins (the nearest board, so nested boards work). If **both** exist in the same
directory it fails with an `ambiguous board` error naming both. The board
root (where locks and state live) is the directory containing the
`board.yaml` found - `.mfw` for the `.mfw/board.yaml` layout.

Overrides, strongest first: `--config <path-to-board.yaml>` (before or after
the command name), then the `MFW_BOARD=<path-to-board.yaml>` env var, then the
search. With no board found it lists what it searched and exits 3.

`mfwb` is the only board CLI; `@mfw/board-core` is a library only (no binary).

Not on `PATH` by default. Invoke it as:

```sh
bun <mfw-checkout>/packages/board/src/cli.ts <command> ...
# or, from the mfw repo:
bun run --cwd packages/board src/cli.ts <command> ...
# or, if linked (packages/daemon/node_modules/.bin/mfwb exists in this repo):
./packages/daemon/node_modules/.bin/mfwb <command> ...
```

## Commands

```
list [--type <type>] [--json] [field=a|b ...] [field~a|b ...]
show [--type <type>] [--json] <id>
create [--type <type>] [--id <id>] [--body <text>] [field=value ...]
update [--type <type>] <id> [--base-rev <n>] [--body <text>] [field=value ...]
claim <id> [--run <runId>] [--worktree <path>] [--lease-ms <n>] [--from <status>]
release <id> --run <runId>
reparent [--type <type>] [--json] <id> <parentId|->
repair [--json]
ready [--type <type>] [--under <id>] [--json] [--unblocks] [field=a|b ...]
ready --check [--under <id>] [--json]
levels [--under <id>] [--format md|tsv|json]
view board [--type <type>] [--under <id>] [--format md|tsv|json]
graph [--under <id>] [--format mermaid|dot|json] [--all]
plan [--under <id>] [--max <n>] [--json]
conflicts [--type <type>] [--json]
validate [--json]
skill install [--global] [--here] [--target <list>] [--dry-run]
skill status [--global] [--target <list>]
```

Global flags: `--config <board.yaml>`, `--json` (list/show/validate/reparent: machine-readable output).

Commands that act on an existing document (`show`, `update`, `reparent`, the
field ops, transition verbs) find its type from the id, so no `--type` is
needed; an id held by several types falls back to `task`, else asks for
`--type`. For `list` and `create`, `--type` defaults to `task` if the board has
a type named `task`, else the only type, else it errors (e.g. `--type adr`).
Ids always carry their key (`MFW-12`, `WH-0042`), in file names and references.
Field names and values come from the board's
`board.yaml` - check it for the exact field list.

### Filters (`list`)

- `field=a|b`: the field equals `a` or `b` (`|` is OR within one filter)
- `field~a|b`: the list field contains `a` or `b`
- several filters are ANDed; `id` can be filtered like a field

### `field=value` syntax

- Plain/enum field: `status=ready`, `priority=high`
- `list: true` field: comma-separated, no spaces: `depends_on=MFW-12,MFW-13`
- `type: json, list: true` field (e.g. acceptance rows): a JSON array literal, parsed whole (commas inside elements are safe), or use `row add`.
- `type: json` field: a raw JSON string, quote it for the shell:
  `verification='{"verifier":"deterministic","checks":[{"files_exist":["src/x.ts"]}]}'`
- `ref` field: the referenced document's id as a plain string: `parent=MFW-5`
- Writes that would close a cycle through an `acyclic` field (`depends_on` ...) are refused with `would create a cycle: A → B → A` (exit 1); `validate` still reports cycles that came in by hand edits.

### Examples

```sh
# everything in backlog
mfwb list status=backlog

# one task, full frontmatter + body
mfwb show MFW-42

# a new task, straight to ready
mfwb create --body "## Goal
Do the thing." \
  title="add the thing" priority=high status=ready \
  verification='{"verifier":"deterministic","checks":[{"files_exist":["src/thing.ts"]}]}'

# edit a field (optimistic concurrency: --base-rev from a prior show/create)
mfwb update MFW-42 --base-rev 3 priority=critical

# an ADR
mfwb create --type adr --body "## Decision
..." title="use X for Y" status=accepted

# sanity-check the whole board (dangling refs, cycles, duplicate ids, schema, hierarchy)
mfwb validate
mfwb validate --json   # {ok, issues: [{kind, type, id, path, message}]}
```

### Exit codes

| code | meaning |
| --- | --- |
| 0 | ok |
| 1 | the command failed (not found, stale `--base-rev`, hierarchy refusal, ...) |
| 2 | usage error |
| 3 | board/config error (no board found, ambiguous board, unreadable/invalid `board.yaml`) |
| 10 | `validate`: document issue (malformed frontmatter, bad/missing field values) |
| 11 | `validate`: id issue (duplicate id, id off its grammar, inherit source missing) |
| 12 | `validate`: reference issue (dangling or wrong-type ref) |
| 13 | `validate`: hierarchy issue (parent/children disagree, rule/maxDepth violation, parent cycle, ambiguous id) |
| 14 | `validate`: cycle (acyclic-field cycle, or a dependency cycle through `depends_on` + hierarchy children) |

When `validate` finds several classes, it exits with the numerically lowest
code present; `--json` always lists every issue with its `kind`
(`document|id|reference|hierarchy|cycle`).

### Hierarchy (parents and children)

Opt in with a `hierarchy:` section in `board.yaml`; the `parent` and `children`
fields it names must be `ref` fields (`children` a list) on the participating types:

```yaml
hierarchy:
  parent: parent
  children: children
  maxDepth: 3                 # optional: longest allowed parent chain
  rules:                      # optional: what may sit under what
    - { child: { type: task, where: { kind: epic } }, parents: [] }          # [] = no parent
    - { child: { type: task, where: { kind: [task, bug] } }, parents: [{ type: task, where: { kind: epic } }] }
    - { child: { type: task, where: { kind: subtask } }, parents: [{ type: task, where: { kind: [task, bug] } }] }
types:
  task:
    fields:
      kind: { values: [epic, task, subtask, bug], default: task }
      parent: { ref: task, optional: true }
      children: { ref: task, list: true, optional: true }
```

All tasks of a board are ONE document type in one directory; their kind (epic,
task, subtask, bug) is a frontmatter field, and rules match on it. A rule's
`child` and each `parents` entry is a type name or `{type, where: {field: value|[values]}}`
(`where` fields are single-valued enum/string fields). The first matching rule
(in order) applies; a document matching no rule may not have a parent. Changing
a `where` field (`update T-5 kind=epic`) is refused if it would break the rules
for the document's current parent or children. Separate document types are for
genuinely different documents (task vs spec vs ADR), not for task kinds.

The two sides are kept in sync by the library: set only `parent` (via
`create ... parent=<id>`, `update <id> parent=<id>`, or `reparent`) and the
parent's `children` list is rewritten under the same lock; `children` is not
written directly. `mfwb reparent <id> <parentId>` moves a document; `-` clears
its parent. A refused change (cycle, max-depth, rule violation, unknown parent,
...) exits 1 with `reparent failed (<code>): ...` and writes nothing.
Any write that touches a parent also rewrites its `children` from the
children's own `parent` fields, so a list desynced by a hand edit heals itself.
After editing parents by hand (or adopting a hierarchy over existing documents),
run `mfwb repair` once: it rebuilds every parent's `children` from the `parent`
fields (existing order kept, stale ids dropped, missing ones appended in id
order) and prints each parent it changed; `validate` then reports anything
repair cannot fix (dangling or disallowed parents, cycles).
Deleting is not a CLI command.

A parent is ready only when all its children **and** its `depends_on` are
terminal. A child that `depends_on` its own parent is a dependency cycle
(`validate` exit 14).

### `skill install` - get this document into your agent tools

Copies this exact file (Agent Skills format: `<skills-dir>/mfwb/SKILL.md`) into
each selected tool's skills directory. Targets: `claude`, `codex`, `opencode`,
`pi`. `--target <list>` takes a comma list, `all`, or `detected` (default:
tools whose executable is on `PATH` or whose global config dir exists; none
detected exits 1, an unknown name exits 2). Default scope is the project: the
nearest ancestor of the cwd containing `.git` (a directory or file), else the
cwd itself; the chosen root is printed on stderr as `project root: <dir>`, and
`--here` forces the cwd. `--global` installs per user.

| tool | project | global |
|---|---|---|
| claude | `.claude/skills` | `$CLAUDE_CONFIG_DIR` or `~/.claude`, `/skills` |
| codex | `.agents/skills` | `$CODEX_HOME` or `~/.codex`, `/skills` |
| opencode | `.opencode/skills` | `$XDG_CONFIG_HOME` or `~/.config`, `/opencode/skills` |
| pi | `.pi/skills` | `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, `/skills` |

Coverage rule: opencode also reads `.claude/skills` and `.agents/skills`, pi
also reads `.agents/skills` (and the global equivalents; opencode's Claude
location follows `$CLAUDE_CONFIG_DIR` like the claude target), and pi/opencode need
unique skill names. So tools are processed in the order claude, codex, pi,
opencode, and a tool whose readable locations already hold a planned install is
reported `covered <tool> by <path>` instead of getting a second copy.

It always overwrites the destination with the packaged copy, never merges, and
reports `installed` / `up-to-date` / `covered` per tool. Re-run after an `mfwb`
upgrade. `--dry-run` prints the plan and writes nothing.

```sh
mfwb skill install                          # detected tools, this project
mfwb skill install --global --target all    # every tool, this machine
mfwb skill install --here                   # use the cwd, not the git root
mfwb skill install --dry-run
mfwb skill status [--global] [--target <list>]   # <tool> <detected|not detected> <path> <installed|missing|stale>
mfwb --json skill status                    # [{tool, detected, scope, path, state, coveredBy}]
```

### Transition verbs - `mfwb <verb> <id> [<text>]`

Boards declare workflow transitions in `board.yaml` (`transitions:` per type);
each verb is a first-class command, listed in `mfwb` usage when a board is found.

```sh
mfwb start MFW-42                       # from -> to, checked atomically under the lock
mfwb done MFW-42 "shipped in abc123"    # text is required exactly when the verb declares `arg`
mfwb done MFW-42 "..." --date 2026-10-03   # explicit date for the verb's `date` field (default: today, UTC)
mfwb done MFW-42 "..." --commit         # then commit ONLY that document file
mfwb defer MFW-42 "needs infra" --push  # --push implies --commit, then `git push`
mfwb --json start MFW-42                # document as JSON
```

A verb's `date: <field>` stamps today's date (UTC); dates are never read out of the text, so to backdate pass `--date YYYY-MM-DD` (a real calendar date, only on verbs that declare `date`). If several types declare the verb, pass `--type`; `--type` naming a type that does not declare it is a one-line error (exit 2). A wrong current status exits 1
(`expected status X or Y, got Z`, file untouched); two concurrent calls on one
document: exactly one wins. Unknown verb / bad or missing text: exit 2.

`--commit` runs `git add -- <file>` then `git commit -m ... -- <file>` in the
document's directory, so unrelated staged/unstaged changes stay out. A held `.git/*.lock` is retried briefly before it counts as a failure. Message:
`<prefix>: <id>: <text or verb, first 60 chars>`; the prefix defaults to the type
name, override per type with `commit: { prefix: tasks }`. A git failure (or no git
work tree) exits 1 with git's stderr and says the transition was already written.

### `claim` / `release` - optional worktree binding

mfw-specific (dependency check + cross-task ownership-overlap check, both
under one lock). Claiming is **optional** and does **not change the task's
status**: it only binds the task to a run and a worktree.

```sh
mfwb claim MFW-42                        # run id generated, worktree = cwd's git toplevel (else cwd)
mfwb claim MFW-42 --run my-run-1 --worktree /path/to/wt
mfwb release MFW-42 --run my-run-1       # unbinds only; status is untouched
```

`claim` prints the document and `run: <id>`; it exits 1 with an explanation if
the task isn't in `--from` status (default `ready`), is already claimed, a
dependency isn't done (when the type declares `statusClasses`: not terminal, counting hierarchy children, the same rule as `ready`), or another active task's `owns` glob overlaps this
one's. `release` exits 1 if the run id doesn't match who holds the binding.
Change status with a transition verb (`mfwb start <id>`, ...) or `update status=...`.
`start` is a plain transition: it does NOT check ownership overlap (`claim` is
the optional guard). A transition into a terminal or parked status releases
the claim binding, so no `release` is needed after `done`/`defer`.

### `ready` / `levels` / `view` - workflow queries (read-only)

Driven by per-type `board.yaml` config: `statusClasses: {terminal, live, parked, queued}`
and `ready: {columns: [...], dependsOn: field}`. The classes: `terminal` = finished
(`done`, `dropped`; unblocks dependents); `parked` = deliberately shelved
(`deferred`); `live` = every other open status, i.e. not finished and not shelved;
`queued` = the live statuses that have not started and may be picked up (so every
`queued` value must also be `live`). "In progress" is `live` minus `queued`.
A document is **ready** when its status is `queued` and all its effective
dependencies (`depends_on` plus hierarchy children) are terminal. Ready does
not mean done.

```sh
mfwb ready [--type t] [--under id] [--json] [--unblocks] [field=a|b ...]   # "<id> <status> deps: <a,b|-> [unblocks: n] | <ready.columns values>"
mfwb ready --check [--under id] [--json]      # exit 1 + "blocked <id>: unresolved dependencies ..." on stderr
mfwb levels [--under id] [--format md|tsv|json]   # id, level, status, title; level = longest dependency chain
mfwb view board [--type t] [--under id] [--format md|tsv|json]   # counts per type/status (+class)
```

`ready --unblocks` adds how many open documents transitively wait on each ready
one; `--json` rows always carry `unblocks`, `chain` (the longest chain behind it)
and every field. `ready` and `ready --check` exit 2 if no type declares `statusClasses`.
`--under` needs a `hierarchy` section. Unknown view names exit 2 and list the valid ones.

### `graph` / `plan` / `conflicts` - decide what to schedule

```sh
mfwb graph [--under id] [--format mermaid|dot|json] [--all]   # dependency graph
mfwb plan [--under id] [--max n] [--json]                     # a conflict-free batch to start together
mfwb conflicts [--type t] [--json]                            # file-scope overlaps among live documents
```

`graph` draws every open document (finished ones only with `--all`): arrows run
dependency -> dependent, hierarchy child edges are dashed, ready documents are
highlighted. Default format is Mermaid; `dot` is Graphviz; `json` is
`{nodes, edges}`. `--under` keeps one subtree.

`plan` answers "what do I start now, in parallel": it takes the ready documents
(skipping parents that merely wait to be closed, listed as "ready to close"),
ranks them by how much each unblocks, then by the chain behind it, and keeps each
one unless its file scope overlaps work in progress or an earlier pick, or `--max`
is reached. Skipped ones are listed with the reason (`overlaps TK-5 (in progress)
on src/z/file.ts ~ src/z/**`). Documents without a scope never conflict. When nothing can start, `plan` lists
the in-progress work that blocks the most (`TK-1: 3 waiting; ready once it
finishes: TK-2, TK-3`).

File scopes are opt-in per type in `board.yaml`:

```yaml
types:
  task:
    ownership: { field: owns, exemptions: shares.yaml }   # exemptions optional
    fields:
      owns: { type: string, list: true, optional: true }  # repo-relative globs
```

`conflicts` lists pairs of live documents whose scopes overlap while neither
depends (transitively) on the other, and exits 1 if any. `validate` rejects
unusable globs (absolute, `..`). The exemptions file (YAML, relative to the board
root) lets two documents share files on purpose:

```yaml
append_only: [src/registry.ts, "**/plan_summary.rs"]   # any pair may overlap here
pairs:
  - cards: [TK-5, TK-6]            # both ids must exist
    paths: [src/z/**, src/z/file.ts]   # both patterns of the overlap must be listed
    ruling: free text              # optional
    note: free text                # optional
```

A declared but missing or invalid exemptions file is a board error (exit 3);
`conflicts` also lists pairs whose documents have both finished (delete them).

### Field operations - typed, race-free edits

Prefer these over `update field=...` when changing one part of a field: each
runs under the document lock on a fresh read, so concurrent edits (two agents
appending to one list) both land. All take `--type`, `--base-rev <n>`, `--json`
and print the updated document. Fields are validated as in `update` (enum
values, types, patterns, ref targets must exist). Hierarchy `parent`/`children`
are refused (use `reparent`).

```sh
mfwb append|prepend <id> <field> <value...>      # list fields; enum/ref lists refuse duplicates
mfwb insert <id> <field> <index> <value...>      # 0-based
mfwb remove <id> <field> <value> [--if-present]  # first occurrence; error if absent unless --if-present
mfwb move <id> <field> <from> <to>
mfwb inc|dec <id> <field> [n]                    # number (default 1; unset counts as 0)
mfwb toggle <id> <field>                         # boolean
mfwb unset <id> <field>                          # optional field (a list becomes empty)
mfwb row <id> <field> add '<json>' | set <rowId> '<json>' | remove <rowId>   # type: json lists, rows keyed by "id"
mfwb note <id> [--section <name>] <text>         # "### <UTC time> - text" under "## Progress" (or --section)
```

**Checklists** (`acceptance: {type: checklist, optional: true}` in `board.yaml`)
hold `{id, text, done}` items in frontmatter; ids (`c1`, `c2`, ...) are assigned
by the tool. Create with `acceptance=a,b,c` or `acceptance='[{"text":"x","done":true}]'`.

```sh
mfwb check <id> <field> add <text>        # prints "added c3"
mfwb check <id> <field> toggle|done|undone|remove <selector>
mfwb check <id> <field> edit <selector> <new text>
```

A `<selector>` is an item id (`c3`) or a text prefix matching exactly one item;
ambiguous or missing selectors fail listing the candidates.

## `board.yaml` quick reference

Everything project-specific lives in the board's `board.yaml` (`mfw: 1` plus
`types:`); read it before creating documents. Per type: `layout: flat|directory`,
`dir`, `primary`/`siblings` (directory layout), `slugFrom`, `id`, `fields`.

- **ids:** `{strategy: own-sequence, key: ABC, suffix?: ADR, pad?: 4, sequence?: name}`
  (`key` is mandatory: ids are always `ABC-12`, never bare numbers; `pad`
  zero-pads; types sharing a `sequence` share one counter and must share `key`
  and `suffix`) or `{strategy: inherit, from: task}`. Ids are
  permanent; explicit ids must match the grammar. There are no split ids.
- **fields:** enum (`values`, `default`), ref (`ref: task`, `ref: [epic, task]`
  or `any`; `list`, `acyclic`), scalar (`type: string|number|boolean|date|json`,
  dates are `YYYY-MM-DD` strings; `pattern: <regex>` on strings, per element on
  lists), `type: checklist`. Common keys: `optional`, `list`, `default`,
  `required_when: {field: value|[values]}`. A `type: json` list may declare
  `rows: {required: [id, text]}`.
- **workflow (per type):** `statusClasses`, `ready`, `transitions`
  (`{from: [...], to: x, arg?: field, date?: field, clear?: [fields]}`; `date` stamps today unless `--date` is given),
  `commit: {prefix}`.
- **ownership (per type):** `ownership: {field: owns, exemptions?: file}`; the
  field must be a string list. Used by `plan`, `conflicts`, `validate`.
- **hierarchy (top level):** the `hierarchy:` section above.

## What this does NOT do

- No scheduling, no agent dispatch, no worktrees, no merging - that's the
  daemon (`packages/daemon`, run via `bun run start`/the `mfw` systemd
  service). `mfwb` only reads and writes board documents (and claim bindings).
- No comments/review state (that's still daemon+SQLite, not board-core
  documents).
