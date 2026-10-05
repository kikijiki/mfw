# mfwb: the board CLI

`mfwb` operates a **board**: markdown documents (tasks, specs, ADRs, anything the
board defines) with YAML frontmatter, kept as plain files on disk. It is the only
board CLI; `@mfw/board-core` is the library behind it (locks, atomic writes,
validation) and has no binary. No daemon is needed, and it is safe to run while the
mfw daemon works on the same board: both go through the same per-document locks.

```sh
bun /path/to/mfw/packages/board/src/cli.ts <command> ...   # or `mfwb` where a wrapper puts it on PATH
```

The agent skill (`skill/SKILL.md`) is the compact version of this file for coding
agents; install it with `mfwb skill install`.

## Concepts

- **Board**: a directory with a `board.yaml`. It declares the document **types**,
  their fields, id scheme and workflow. Everything project-specific lives there.
- **Document**: `<dir>/<ID>-<slug>.md` (or a directory with a primary file). The
  frontmatter holds `mfw: 1`, `id`, `rev` and the type's fields; the body is
  markdown. Which type a document has is decided by where it lives, not by a field.
- **Id**: always `<KEY>-<number>` (`MFW-12`, `WH-0042`, `ABC-ADR-0104`). Permanent:
  never renumbered or split. Types sharing an `id.sequence` share one number space.
- **Kind vs type**: a *type* is a different kind of document (task, spec, ADR). The
  kind of a task (epic, task, subtask, bug) is an ordinary field of the `task` type.
- **Workflow** (opt-in, per type): status classes, `ready`, transitions.
- **Hierarchy** (opt-in): `parent` / `children` relations between documents.

### Finding the board

Like `.gitignore`: from the current directory upward, in each directory `board.yaml`
then `.mfw/board.yaml`; the first hit wins (both in one directory is an error).
Override with `--config <path-to-board.yaml>` (before or after the command) or the
`MFW_BOARD` environment variable. No board found: exit 3.

### `--type`

Commands that act on an existing document (`show`, `update`, `reparent`, the field
operations, transition verbs) find its type from the id. `list` and `create` default
`--type` to `task` when the board has one, else to its only type.

## `board.yaml` in one screen

```yaml
mfw: 1
hierarchy:                       # optional
  parent: parent
  children: children
  maxDepth: 3
  rules:                         # what may sit under what, matched on a field's value
    - { child: { type: task, where: { kind: epic } }, parents: [] }
    - { child: { type: task, where: { kind: task } }, parents: [{ type: task, where: { kind: epic } }] }
types:
  task:
    layout: flat                 # flat | directory
    dir: tasks
    id: { strategy: own-sequence, key: ABC, pad: 3, sequence: cards }   # key is mandatory
    ownership: { field: owns, exemptions: shares.yaml }                 # optional file scopes
    statusClasses: { terminal: [done], live: [todo, doing], parked: [deferred], queued: [todo] }
    ready: { columns: [kind, agent], dependsOn: depends_on }
    transitions:                 # each verb becomes a command
      start: { from: [todo], to: doing }
      done: { from: [todo, doing], to: done, arg: outcome, date: closed }
    commit: { prefix: abc }
    fields:
      title: {}
      kind: { values: [epic, task], default: task }
      status: { values: [todo, doing, done, deferred], default: todo }
      depends_on: { ref: task, list: true, acyclic: true, optional: true }
      parent: { ref: task, optional: true }
      children: { ref: task, list: true, optional: true }
      owns: { type: string, list: true, optional: true }
```

Field kinds: enum (`values`), ref (`ref: type`, a list of types, or `any`; `list`,
`acyclic`), scalar (`type: string|number|boolean|date|json`, `pattern`), and
`type: checklist`. Common keys: `optional`, `list`, `default`, `required_when`.

## Commands

Global flags: `--config <board.yaml>`, `--json` (machine-readable output where noted).
Exit codes: 0 ok; 1 the command failed; 2 usage error; 3 board/config error; for
`validate` 10 document, 11 id, 12 reference, 13 hierarchy, 14 cycle (lowest present).

### Read

| Command | What it does |
| --- | --- |
| `mfwb list [--type t] [--json] [field=a\|b ...] [field~a\|b ...]` | Documents of a type. `field=a\|b`: equals a or b; `field~a\|b`: list contains. Filters AND together. |
| `mfwb show [--type t] [--json] <id>` | One document: frontmatter and body. |
| `mfwb validate [--json]` | Checks the whole board: schema, ids, references, hierarchy, dependency cycles, file-scope globs. `--json` lists every issue with its `kind`. |

### Create and edit

| Command | What it does |
| --- | --- |
| `mfwb create [--type t] [--id id] [--body text] [field=value ...]` | New document with the next id. `list` fields take comma-separated values, `json` fields a JSON literal (a `json` list a JSON array). |
| `mfwb update [--type t] <id> [--base-rev n] [--body text] [field=value ...]` | Change fields or body. `--base-rev` fails the write if the document changed since you read it. Writes that would close a dependency cycle through an `acyclic` field are refused. |
| `mfwb append\|prepend <id> <field> <value...>` | Add to a list field (enum/ref lists refuse duplicates). |
| `mfwb insert <id> <field> <index> <value...>` | Insert into a list at a 0-based index. |
| `mfwb remove <id> <field> <value> [--if-present]` | Remove the first occurrence. |
| `mfwb move <id> <field> <from> <to>` | Reorder a list item. |
| `mfwb inc\|dec <id> <field> [n]` | Add to or subtract from a number (unset counts as 0). |
| `mfwb toggle <id> <field>` | Flip a boolean. |
| `mfwb unset <id> <field>` | Clear an optional field (a list becomes empty). |
| `mfwb row <id> <field> add '<json>' \| set <rowId> '<json>' \| remove <rowId>` | Edit rows of a `json` list keyed by `id`. |
| `mfwb note <id> [--section name] <text>` | Append a timestamped entry under `## Progress` (or the named section). |
| `mfwb check <id> <field> add <text>` | Checklist fields: add an item (ids `c1`, `c2`, ... are assigned). Also `toggle\|done\|undone\|remove <selector>` and `edit <selector> <new text>`; a selector is an item id or a unique text prefix. |

The field operations run under the document's lock on a fresh read, so two agents
appending to one list both land. All take `--type`, `--base-rev`, `--json`. Text that
starts with `--` goes after a bare `--`.

### Hierarchy

| Command | What it does |
| --- | --- |
| `mfwb reparent [--type t] [--json] <id> <parentId\|->` | Move a document under another (`-` clears the parent). Both sides stay in sync; refusals (cycle, depth, rules) exit 1 and write nothing. |
| `mfwb repair [--json]` | Rebuild every parent's `children` from the children's `parent` fields. Use after editing parents by hand. Any write touching a parent does this for that parent too. |

### Workflow: what is ready, what to schedule

| Command | What it does |
| --- | --- |
| `mfwb ready [--type t] [--under id] [--json] [--unblocks] [field=a\|b ...]` | Documents that can start: status in `queued` and every dependency (`depends_on` plus hierarchy children) finished. `--unblocks` adds how many open documents each one frees. |
| `mfwb ready --check [--under id] [--json]` | Exit 1 if some live document can never become ready (dangling or parked dependency, cycle). |
| `mfwb levels [--under id] [--format md\|tsv\|json]` | Each document's level: the longest dependency chain below it. Level 0 starts now, level 1 after those, and so on. |
| `mfwb view board [--type t] [--under id] [--format md\|tsv\|json]` | Counts per type and status, with the status class. |
| `mfwb graph [--under id] [--format mermaid\|dot\|json] [--all]` | The dependency graph (arrows run dependency to dependent; children dashed; ready highlighted). Finished documents only with `--all`. |
| `mfwb plan [--under id] [--max n] [--json]` | A conflict-free batch of ready documents to start in parallel: ranked by what they unblock, skipping any whose file scope overlaps work in progress or an earlier pick (reasons listed). Needs `ownership` to avoid file clashes; without it nothing conflicts. When nothing can start it lists the in-progress work blocking the most tasks and what becomes ready when it finishes. |
| `mfwb conflicts [--type t] [--json]` | Live documents whose file scopes overlap with nothing ordering them. Exit 1 if any. |

File scopes are opt-in (`ownership: {field, exemptions?}` on a type). The exemptions
file lets two documents share files on purpose: `append_only` globs, and `pairs` of
`{cards: [A, B], paths: [...]}`.

### Transition verbs

The `transitions:` of a type become commands: `mfwb <verb> <id> [<text>] [--type t]
[--date YYYY-MM-DD] [--commit] [--push] [--json]`. Examples with the config above:

```sh
mfwb start ABC-12                       # todo -> doing, checked atomically under the lock
mfwb done ABC-12 "landed in abc123"     # text is required exactly when the verb declares `arg`
mfwb done ABC-12 "backfill" --date 2026-09-30   # a verb's `date` field is today; backdate explicitly
mfwb done ABC-12 "..." --commit         # then commit ONLY that document's file
```

`--commit` commits just that file (other changes stay out); `--push` implies it and
then pushes. Dates are never read out of the text. A wrong current status exits 1
with the file untouched. A parent cannot finish while a child is open.

### Claiming work (optional)

| Command | What it does |
| --- | --- |
| `mfwb claim <id> [--run id] [--worktree path] [--lease-ms n] [--from status]` | Bind a ready task to a run and worktree under one lock, checking dependencies and file-scope overlap with active tasks. Does not change status. |
| `mfwb release <id> --run <id>` | Unbind it. Transitions into a finished or parked status release it too. |

### The skill

| Command | What it does |
| --- | --- |
| `mfwb skill install [--global] [--here] [--target list] [--dry-run]` | Copy the mfwb skill into detected agent tools (claude, codex, opencode, pi), at the git root (`--here`: the current directory) or per user (`--global`). Skips a tool that already reads another install. |
| `mfwb skill status [--global] [--target list]` | Where it is installed and whether it is current. |

## Typical flow

```sh
mfwb ready --unblocks            # what can start, and what finishing it frees
mfwb plan --max 4                # a batch that will not collide
mfwb claim ABC-12                # optional: bind it to your worktree
mfwb start ABC-12
mfwb note ABC-12 "found the cause"
mfwb check ABC-12 acceptance done c2
mfwb done ABC-12 "landed in abc123" --commit
mfwb graph --under ABC-3 > plan.mmd
```
