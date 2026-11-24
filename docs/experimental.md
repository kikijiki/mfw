# Experimental features

mfw is pre-release. The features below work to some degree, but they have not
reached the safety or testing bar of the default local sandbox. Their behaviour
and settings can change without notice. Do not rely on them for anything you
cannot afford to lose.

| Feature | Status | How it is switched on | Main limit |
| --- | --- | --- | --- |
| [Remote targets (SSH)](#remote-targets-ssh-and-runpod) | off by default, never autonomous | `MFW_EXPERIMENTAL_REMOTE=1` | no sandbox-profile parity |
| [RunPod](#remote-targets-ssh-and-runpod) | off by default, never autonomous | `MFW_EXPERIMENTAL_REMOTE=1` plus account setup | same, and it spends money |
| [ACP agents](#acp-agents) | unsandboxed only | `agentIsolation: "none"`, `approvalMode: "interactive"` | run as your user |
| [Scoped API tokens](#scoped-api-tokens) | on, awaiting outside review | `mfw auth token create` | no second-party review yet |
| [Passkeys](#passkeys) | on, awaiting review | Settings > Passkeys | Chrome's virtual authenticator only |
| [Clone workspaces](#clone-workspaces) | required for sandboxed runs, not yet the default | `"runWorkspace": "clone"` | default flip is pending |
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

## ACP agents

Cursor, Gemini CLI, opencode, pi and other Agent Client Protocol agents have no
sandbox profile. A sandboxed launch refuses them, so they need
`agentIsolation: "none"` with `approvalMode: "interactive"`, and then run with your
user's permissions. The brain's chat and the change-review critic refuse ACP
transports, because they could read the machine while handling untrusted text.

## Scoped API tokens

Tokens for MCP clients and scripts have had an internal security review. They
stay labelled experimental until a second party reviews them. Prefer short
lifetimes and the narrowest scope.

## Passkeys

Passkey sign-in is verified by `@simplewebauthn/server` (ES256 and EdDSA), with
mfw's policy around it, and tested with a software authenticator and Chrome's
virtual authenticator. The integration has not been reviewed or tried on real
devices. CI must run `bun run smoke:auth` with Chrome
installed and `MFW_SMOKE_CHROME=1`: that is the only run against a signer other
than mfw's own test authenticator, and without the variable a missing Chrome only
skips it. RSA keys (RS256), which some older Windows
Hello setups create, are not accepted.

Adding a passkey needs the browser to report the `credProps` extension, which
says whether the passkey was stored on the device. mfw refuses the passkey
when the browser leaves it out, because one that is not stored there could
never sign in. Chrome reports it (tested with its virtual authenticator).
Recent Firefox and Safari releases are expected to, but that has not been
checked here. Older releases, and password-manager extensions that take over
WebAuthn without passing it through, cannot add a passkey; use the password
or another browser. The password always keeps working.

## Clone workspaces

Sandboxed runs need a private clone per run, but the configured default is still
`worktree`. Until the default flips, **a new project starts no runs** until you add
`"runWorkspace": "clone"` to its entry in `$MFW_HOME/config.json` and restart.
The default stays put until these hold on real hosts: the resource limits, real
agent CLIs through the whole path, and project dev shells in the sandbox.

Two limits follow today:

- A project with an `.envrc` is refused, because dev shells do not run inside the
  sandbox yet.
- A check only has the repository's tracked files. If it needs installed
  dependencies, it is reported as an infrastructure result.

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
