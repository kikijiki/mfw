# Experimental features

mfw is pre-release. The features below work to some degree, but they have not
reached the safety or testing bar of the default local sandbox. Their behaviour
and settings can change without notice. Do not rely on them for anything you
cannot afford to lose.

| Feature | Status | How it is switched on | Main limit |
| --- | --- | --- | --- |
| [Remote targets (SSH)](#remote-targets-ssh-and-runpod) | off by default, never autonomous | `MFW_EXPERIMENTAL_REMOTE=1` | no sandbox-profile parity; work does not come back yet |
| [RunPod](#remote-targets-ssh-and-runpod) | off by default, never autonomous | `MFW_EXPERIMENTAL_REMOTE=1` plus account setup | same, and it spends money |
| [ACP agents](#acp-agents) | unsandboxed only | `agentIsolation: "none"`, `approvalMode: "interactive"` | run as your user; work does not come back yet |
| [Scoped API tokens](#scoped-api-tokens) | on, awaiting outside review | `mfw auth token create` | no second-party review yet |
| [Checks without dependencies](#checks-without-dependencies) | always | none | a check that needs `node_modules` and the like cannot pass yet |
| [Host-run triggers](#host-run-triggers) | inert until armed | arm in the Triggers view | run as your user |
| [Tailscale and proxy exposure](#tailscale-and-proxy-exposure) | opt-in | `MFW_LISTEN_SOCKET`, `MFW_TRUSTED_PROXIES` | not run against a real `tailscale serve` |
| [Codex under the sandbox](#codex-under-the-sandbox) | enabled, unproven | choose Codex as the provider | inner sandbox conflict, not retested |
| [Model endpoints and OpenRouter](#model-endpoints-and-openrouter) | opt-in | provider settings | prompts and code go to that service |

`mfw doctor` reports the host and project settings behind several of these, such
as isolation, exposure and egress. It does not yet list every active item here.

## Remote targets (SSH and RunPod)

Remote execution is gated by `MFW_EXPERIMENTAL_REMOTE=1` and is refused for
autonomous runs (`packages/daemon/src/remote-experimental.ts`). A remote agent
runs in a same-uid `bwrap` with open network access, so none of the local egress
protections apply to it. RunPod also rents paid machines, so check your account
for leftovers after using it.

A remote run is staged from the trusted primary (the base commit, or the work
an earlier run handed back). What it collects is written into the run's local
clone, but nothing turns that into an imported result yet, so a remote run's
work is not verified or merged.

## ACP agents

Cursor, Gemini CLI, opencode, pi and other Agent Client Protocol agents have no
sandbox profile. A sandboxed launch refuses them, so they need
`agentIsolation: "none"` with `approvalMode: "interactive"`, and then run with your
user's permissions. The brain's chat and the change-review critic refuse ACP
transports, because they could read the machine while handling untrusted text.

Every run works in a private clone, and a run's work comes back only as the
bundle the in-sandbox WIP helper writes at the end of the run. An unsandboxed
run (`agentIsolation: "none"`, so every ACP agent) has no such helper yet: it
can work in its clone, but its result is not imported, verified or merged.

## Scoped API tokens

Tokens for MCP clients and scripts have had an internal security review. They
stay labelled experimental until a second party reviews them. Prefer short
lifetimes and the narrowest scope.

## Checks without dependencies

A check runs in a disposable clone of the commit, which holds only the
repository's tracked files. If it needs installed dependencies, it is reported as
an infrastructure result rather than a failure. Project dev shells in the sandbox
are not available yet, so a project with an `.envrc` is refused.

## Host-run triggers

A trigger with a `script` action runs an owner-approved command on the host, as
your user and outside the sandbox. Arming pins the command to its commit's whole
tree and runs it from a sealed checkout. The pin controls what starts, but the
command can then do anything you can. Review the file list when you arm one.

## Tailscale and proxy exposure

[exposure.md](exposure.md) describes the private-socket setup. It has been tested
with a simulated proxy, not with a real `tailscale serve`. Run
`tools/tailscale-serve-check.sh` and the browser checklist before relying on it.

## Codex under the sandbox

The Codex bridge requests Codex's `workspace-write` sandbox, while mfw's sandbox
disables the nested user namespaces such a sandbox normally needs. In earlier
experiments this made Codex's shell calls fail, and the current path has not been
retested with a real CLI. mfw verifies results on the host, so a run that did no
work does not pass its checks. Expect Codex task runs to need work.

## Model endpoints and OpenRouter

OpenAI-compatible endpoints and OpenRouter receive the prompts and code a run
sends them. Their keys are stored in `$MFW_HOME/credentials.json`.
