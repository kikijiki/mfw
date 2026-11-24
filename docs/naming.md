# Names

The canonical name of each piece of mfw, and what it refers to. New code, docs,
messages and packaging use these names and no others. mfw is in early
development: an old name is renamed outright, never kept as an alias.

## Executables and commands

| Name | What it is |
| --- | --- |
| `mfw` | the one CLI. Subcommands: `auth`, `board`, `doctor`, `env`, `init`, `mcp`, `server`, `version` |
| `mfw-board` | the standalone board CLI (no server needed). `mfw board ...` runs it |
| `mfw server` | runs `mfw-server` in the foreground (what the service's `ExecStart` runs) |
| `mfw mcp` | the MCP server over stdio, in the `mfw` process |
| `mfw __host <id>` | internal to a compiled install: the host scripts the server runs |

## Processes and agents

| Name | What it is |
| --- | --- |
| `mfw-server` | the server process: the engine (scheduler, runs, verification, merge queue, triggers, resources), the API and the web UI, in one process. In prose, "the server" |
| the engine | the part of `mfw-server` that does the work. Its code is the `packages/daemon` package |
| the brain | the tech-lead agent that turns direction into tasks and decides inside its rights |
| a run | one agent process in its sandbox, on a private clone called its workspace |

## Service

| Name | What it is |
| --- | --- |
| `mfw-server` | the systemd user unit: `packaging/mfw-server.service`, and `services.mfw-server` in the home-manager module (`packaging/mfw.home-manager.nix`). `mfw-server.service` is what a deploy restarts |

## Environment variables

Every variable mfw reads is `MFW_*`, apart from the server's `HOST` and `PORT`.

| Name | What it sets |
| --- | --- |
| `MFW_HOME` | the per-user state directory (default `~/.local/share/mfw`) |
| `MFW_BOARD` | the `board.yaml` the board CLI uses, instead of searching for one |
| `MFW_BOARD_ROOT_<NAME>` | where a board root named `<name>` is on this machine |
| `MFW_URL`, `MFW_TOKEN` | the server and API token `mfw mcp` uses |
| `MFW_LISTEN_SOCKET`, `MFW_ALLOWED_HOSTS` | exposure through a proxy (see [exposure](exposure.md)) |
| `MFW_BASE_PATH` | the path the web UI is mounted at |
| `MFW_LOG_LEVEL` | the server's log level |
| `MFW_SERVE_UI_ONLY=1` | serve the web UI with no projects attached (development) |
| `MFW_EXPERIMENTAL_REMOTE=1` | enable the experimental remote targets |
| `MFW_TMUX_SOCKET` | the tmux socket for agent runs (default `mfw`; tests set their own) |

## On disk

| Path | What it holds |
| --- | --- |
| `$MFW_HOME/config.json` | the machine config; an unknown key refuses the load |
| `$MFW_HOME/auth.db` | the owner, sessions, tokens and passkeys |
| `$MFW_HOME/host/host.db` | the resource core: pools, leases, holds, the machine ledger |
| `$MFW_HOME/server.lock` | held by the running server |
| `$MFW_HOME/setup-token`, `$MFW_HOME/mcp-token` | the first-run setup token, the MCP client's API token |
| `$MFW_HOME/serve/mfw.sock` | the listen socket when `MFW_LISTEN_SOCKET` points there |
| `<repo>/.mfw/mfw.db` | the project database (runs, events, merge queue) |
| `<repo>/.mfw/server.lock` | held by the server attached to the project |
| `<repo>/.mfw/runs/<id>/` | one run's directory |
| `<repo>/.mfw/triggers/` | the project's trigger definitions |
| `<board folder>/board.yaml` | the board; mfw's own settings live under its `x-mfw` key |
| `mfw-board/SKILL.md` | the agent skill, under each agent tool's skills directory |
| tmux socket `mfw` | the tmux server agent runs live in (`tmux -L mfw`) |

## Values

| Name | Where |
| --- | --- |
| `cwd: repo`, `cwd: workspace` | a trigger script runs in the primary checkout, or in a throwaway checkout of `MFW_SHA` |
| `integration-workspace`, `primary` | where a reopen check runs |
| `verification` | a task's mechanical checks (never "dod") |

## Versions

There is no migration path between development versions. Each store has one
schema: the project database one baseline migration, `auth.db` and `host.db`
one stamped schema each. A file from another version is refused at open with
the fix (delete it), never read or upgraded.
