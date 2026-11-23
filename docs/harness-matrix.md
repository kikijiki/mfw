# Harness matrix

<!-- Generated from the built-in harness manifests. Do not edit. Run: bun run harness:matrix -->

What mfw knows about each agent CLI it can drive. The manifests in `packages/plugin-api/src/harness-builtins.ts` are the source.

## Harnesses

| Harness | Id | Binary | Protocol | Version | Endpoints |
|---|---|---|---|---|---|
| Claude Code | `claude-cli` | `claude` | `claude-stream-json` | any | no |
| OpenAI Codex CLI | `codex-cli` | `codex` | `codex-app-server` | any | yes |
| Gemini CLI | `gemini-cli` | `gemini` | `acp` | any | no |
| Cursor Agent | `cursor-agent` | `agent` | `acp` | any | no |
| opencode | `opencode` | `opencode` | `acp` | any | yes |
| pi | `pi` | `pi` | `acp` | `>=0.81` | yes |

## Capabilities

As each task bridge declares them. A brain turn can differ: Codex brain turns use `codex exec`, which cannot be steered.

| Capability | Claude Code | OpenAI Codex CLI | Gemini CLI | Cursor Agent | opencode | pi |
|---|---|---|---|---|---|---|
| Streaming | yes | yes | yes | yes | yes | yes |
| Steering | yes | yes | no | no | no | no |
| Interrupt | yes | yes | yes | yes | yes | yes |
| Approvals | no | yes | yes | yes | yes | yes |
| Tools | yes | yes | yes | yes | yes | yes |
| MCP (task bridge) | no | yes | no | no | no | no |
| Plan mode | no | yes | yes | yes | yes | yes |
| File-change events | no | yes | yes | yes | yes | yes |
| Command progress | no | yes | yes | yes | yes | yes |
| Resume | yes | yes | yes | yes | yes | yes |

## Sessions, usage and login

| Harness | Resume | Usage source | Login kinds |
|---|---|---|---|
| Claude Code | `session-id-flag`: --session-id on the first turn, --resume <id> after | `rate-limit-event` | subscription, api-key |
| OpenAI Codex CLI | `thread-arg`: exec on the first turn, exec resume <thread> after | `app-server-rpc` | subscription, api-key |
| Gemini CLI | `acp-session`: session/resume when the agent offers it, else session/load | `none` | api-key |
| Cursor Agent | `acp-session`: session/resume when the agent offers it, else session/load | `none` | subscription, api-key |
| opencode | `acp-session`: session/resume when the agent offers it, else session/load | `none` | api-key |
| pi | `acp-session`: session/resume when the agent offers it, else session/load | `none` | subscription |

## Sandbox

Only harnesses with a fleet directory run in the agent sandbox today. A list marked `unattested-config` is provisional and has not been checked against an authenticated CLI.

| Harness | Fleet dir | Writable | Attestation | User namespace | Inner sandbox |
|---|---|---|---|---|---|
| Claude Code | `CLAUDE_CONFIG_DIR` | `backups`, `projects`, `sessions` | `unattested-config` | not needed | none |
| OpenAI Codex CLI | `CODEX_HOME` | `cache`, `sessions`, `shell_snapshots`, `thread-writer-locks`, `tmp` | `unattested-config` | not needed | `workspace-write` via app-server-rpc |
| Gemini CLI | none | none | n/a | not needed | none |
| Cursor Agent | none | none | n/a | not needed | none |
| opencode | none | none | n/a | not needed | none |
| pi | none | none | n/a | not needed | none |

## Network

Exact host and port, deny by default. Telemetry hosts need the owner's opt-in. API-key hosts open only for a run launched with that harness's key.

| Harness | Host | Port | Purpose | Condition |
|---|---|---|---|---|
| Claude Code | `api.anthropic.com` | 443 | inference | always |
| Claude Code | `platform.claude.com` | 443 | auth | always |
| Claude Code | `http-intake.logs.us5.datadoghq.com` | 443 | telemetry | telemetry opt-in |
| Claude Code | `browser-intake-us5-datadoghq.com` | 443 | telemetry | telemetry opt-in |
| OpenAI Codex CLI | `chatgpt.com` | 443 | inference | always |
| OpenAI Codex CLI | `api.openai.com` | 443 | inference | `OPENAI_API_KEY` set |
| OpenAI Codex CLI | `auth.openai.com` | 443 | auth | always |
| OpenAI Codex CLI | `ab.chatgpt.com` | 443 | telemetry | telemetry opt-in |

## Autonomy flags

A non-autonomous launch may carry only the arguments mfw generates for that CLI. These are the second layer: a launch carrying any of them is refused.

| Harness | Flags |
|---|---|
| Claude Code | `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions`, `--permission-mode auto`, `--permission-mode acceptEdits` |
| OpenAI Codex CLI | `--dangerously-bypass-approvals-and-sandbox`, `--full-auto`, `--yolo`, `--approve-for-me`, `--ask-for-approval never`, `-a never`, `--sandbox danger-full-access`, `-s danger-full-access`, `-c approval_policy=never`, `-c sandbox_mode=danger-full-access` |
| Gemini CLI | `--yolo`, `-y`, `--approval-mode yolo`, `--approval-mode auto_edit` |
| Cursor Agent | `--force`, `-f`, `--yolo`, `--approve-mcps` |
| opencode | `--dangerously-skip-permissions` |
| pi | `--approve` |

## Project files

Changes to these paths count as host-executed at merge.

| Harness | Config files | Directories | Skills |
|---|---|---|---|
| Claude Code | `.claude/settings.json`, `.claude.json`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md` | `.claude` | `.claude/skills` |
| OpenAI Codex CLI | `.codex/config.toml`, `AGENTS.md`, `AGENTS.override.md` | `.codex` | `.agents/skills` |
| Gemini CLI | `.gemini/settings.json`, `GEMINI.md` | `.gemini` | none |
| Cursor Agent | `.cursor/mcp.json`, `.cursor/cli.json`, `.cursorrules` | `.cursor` | none |
| opencode | `opencode.json`, `opencode.jsonc`, `.opencode/opencode.json` | `.opencode` | `.opencode/skills` |
| pi | `.pi/mcp.json`, `.pi/settings.json` | `.pi` | `.pi/skills` |
