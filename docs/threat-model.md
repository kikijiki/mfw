# Threat model

This document says what mfw defends, against whom, with which code, and where the
defence stops. Every mechanism below names the file that enforces it. If the code
and this page disagree, that is a bug: please report it through
[SECURITY.md](../SECURITY.md).

It describes the default local setup: one owner, one Linux x86_64 machine,
`agentIsolation: "bwrap"` and `runWorkspace: "clone"`. For how the parts fit
together, see the [architecture overview](architecture-overview.md).

## Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| The owner's files and credentials | the real home directory | the main thing an agent must never reach |
| mfw's control state | `$MFW_HOME`: `config.json`, `auth.db`, `credentials.json`, `triggers/`, `host/host.db` | controls what the host runs, and who may sign in |
| Project state | `<project>/.mfw/`: `mfw.db`, run directories | the record of runs, decisions and evidence |
| The primary repository | the project checkout and its `.git` | the code, its history, hooks and config |
| The integration branch and its remote | local branch, `origin` | merged code is later built, run and published |
| Agent CLI logins | `$MFW_HOME/agents/{claude,codex}` | vendor account access and spend |
| Provider API keys and trigger secrets | `$MFW_HOME/credentials.json` (0600) | third-party accounts |
| The owner's session and API tokens | `auth.db` (hashes), browser, `mcp-token` | full or scoped control of mfw |
| Compute and money | CPU, memory, disk, vendor quota, RunPod | an agent can burn all of them |
| The owner's attention and trust | inbox, Lead, claims | a forged "verified" is an attack too |

## Trust levels

- **Trusted:** the owner, the mfw code that was built and installed, the kernel,
  `bwrap`, git, and the operator's own global git config.
- **Bounded:** the project brain. It is an agent, so it can be misled, and it acts
  only through validated tools.
- **Untrusted:** everything an agent writes, repository content, diffs, CI logs,
  dependency code, and text written through an API token.

## Trust boundaries and what enforces them

### 1. Agent to host filesystem and processes

A sandbox is compiled from a closed, versioned profile. An omitted section means
deny, and a profile that cannot be enforced is refused.

| Control | Mechanism | Code |
| --- | --- | --- |
| Profile schema, per-role ceilings | unknown keys rejected, read-only roles cannot get a writable workspace | `packages/daemon/src/containment/profile.ts`, `packages/daemon/src/containment/role-profiles.ts` |
| Namespaces and privileges | `--unshare-all`, `--disable-userns`, `--cap-drop ALL`, `--new-session`, `--die-with-parent`, read-only root, synthetic home | `packages/daemon/src/containment/compile-bwrap.ts` |
| Bind integrity | sources opened as descriptors and identity-checked, so a swapped path is refused | `packages/daemon/src/containment/pinned-binds.ts` |
| Syscall filter | denylist with process-inspection, mount, keyring, BPF, `io_uring` and module calls, plus an allowlist of socket families. x86_64 only | `packages/daemon/src/containment/seccomp.ts` |
| Descriptors and terminal | exact descriptor table, pipes only, a terminal is refused | `packages/daemon/src/containment/launch-sandbox.ts` |
| Resource limits | `systemd-run --user --scope` with `TasksMax`, `MemoryMax`, `MemorySwapMax=0` | `packages/daemon/src/containment/limits.ts` |
| Run directory | host-only root, read-only `control/`, writable `outbox/` | `packages/daemon/src/containment/run-dir.ts` |
| Host tools | resolved from trusted `PATH` entries outside agent-writable roots | `packages/daemon/src/sandbox.ts` |

### 2. The launch chain

Every autonomous launch passes four steps, in order. There is no flag to skip one.

1. **Probe.** A probe runs inside the same sandbox the agent will get and checks
   24 outcomes, including routes, DNS, seccomp, capabilities, writable mounts,
   absent secrets and home, planted sockets and executables, and cgroup limits
   (`packages/daemon/src/containment/probe-child.ts`,
   `packages/daemon/src/containment/probe-evaluate.ts`).
2. **Attestation.** The host records the result in append-only tables, which
   database triggers protect from update and delete
   (`packages/daemon/src/containment/attestation-store.ts`).
3. **Authorization.** The gate requires the run's newest attestation to be
   passing, recent, under the systemd scope and for the same profile, options,
   seccomp program, bind sources and `bwrap` version. It consumes the attestation
   and issues a single-use token
   (`packages/daemon/src/containment/attestation-gate.ts`,
   `packages/daemon/src/containment/launch-authorization.ts`).
4. **Launch.** `launchSandbox` starts an autonomous command only with that token,
   and cannot drop the scope for it
   (`packages/daemon/src/containment/launch-sandbox.ts`).

### 3. Agent to network

| Control | Mechanism | Code |
| --- | --- | --- |
| No direct network | an empty network namespace, so host loopback and abstract sockets are out of reach | `packages/daemon/src/containment/compile-bwrap.ts` |
| One proxy per run | a unix socket visible only to that run | `packages/daemon/src/containment/egress-run.ts`, `packages/daemon/src/containment/egress-relay.ts` |
| Allowlist | exact host and port per harness, no wildcards or IP literals | `packages/daemon/src/containment/egress-allowlists.ts`, `packages/daemon/src/containment/egress-policy.ts` |
| DNS and TLS checks | resolve once, refuse non-public answers, connect to the pinned address, require a matching TLS server name | `packages/daemon/src/containment/egress-proxy.ts` |
| Upload budget | 1 GiB per destination and 2 GiB per run by default. A breach closes the run's tunnels and raises a critical inbox item | `packages/daemon/src/containment/egress-proxy.ts` |

See [egress.md](egress.md) for the hosts and settings.

### 4. Agent results to the host

The host never runs git in an agent-writable repository.

| Control | Mechanism | Code |
| --- | --- | --- |
| Fetch-only import | the agent's work arrives as a bundle, is copied, validated in a throwaway bare repository, then enters a quarantine ref | `packages/daemon/src/host-git/fetch.ts`, `packages/daemon/src/run-workspace/clone-impl.ts` |
| Hardened git runner | explicit gitdir, scrubbed environment, `fsck`, memory and CPU caps on every child | `packages/daemon/src/host-git/runner.ts` |
| Refusal for plain git | ordinary host git refuses any path under a run workspace | `packages/daemon/src/host-git/legacy-guard.ts` |
| Repository config allowlist | a repository config key outside the list refuses the host git call | `packages/daemon/src/host-git/repo-config.ts` |
| Minimal seed | a clone holds only objects reachable from its base commit, so other branches are not exposed | `packages/daemon/src/run-workspace/seed.ts` |

### 5. Verification

Checks run the candidate's code, so they run in a disposable clone of one commit,
in the `verifier` or `merge-verify` role, with no network, credentials or ambient
environment (`packages/daemon/src/containment/check-sandbox.ts`,
`packages/daemon/src/verifier.ts`,
`packages/daemon/src/run-workspace/verifier-clone.ts`). A check that cannot run
there is reported as an infrastructure result and is never retried on the host.
See [verifier-sandbox.md](verifier-sandbox.md).

### 6. Merge and push

| Control | Mechanism | Code |
| --- | --- | --- |
| Merge pinned to the verified commit | the queue lands the commit that passed, and a moved tip is refused | `packages/daemon/src/merge-queue.ts` |
| Ask-first gate | a change to a host-executed path, or to an executing `package.json` field, waits on an owner card. The approval is bound to that content and used once | `packages/daemon/src/merge-gate.ts`, `packages/daemon/src/brain-runtime/decision-rights.ts` |
| Host-owned landing repository | merges and pushes run from a repository with an empty config, so the primary's hooks and filters are not read | `packages/daemon/src/host-git/landing.ts` |
| Approved push URL | the destination comes from the daemon home, never from `remote.<name>.url` | `packages/daemon/src/host-git/push.ts` |

### 7. What the host executes

| Control | Mechanism | Code |
| --- | --- | --- |
| Built host scripts | a production server runs only its built copies, hash-checked at each lookup | `packages/daemon/src/containment/host-script.ts`, `tools/build-host-scripts.ts` |
| Compiled install | every host process is `mfw __host <id>`: the install's `mfw`, checked against `install.json` before each use, or inside `mfw` its own running image. The install has no script files, and removing its manifest leaves a bundle with no scripts, which refuses every launch | `packages/daemon/src/containment/host-script.ts`, `packages/daemon/src/containment/install-manifest.ts`, `packages/cli/src/host-exec.ts` |
| Install location | the prefix, every parent, every file of the bundle, both executables and the runtime must be root-owned (or in the Nix store), not group- or world-writable, and outside agent-writable trees. Otherwise the server warns, the doctor reports a blocker, and autonomous launches are refused unless the owner accepts that exact prefix (`acknowledgeUntrustedInstall`) | `packages/daemon/src/containment/install-trust.ts`, `packages/daemon/src/containment/install-launch-check.ts` |
| Install check | every launch re-hashes the whole install, and the server re-hashes `mfw` before each host process. `mfw server` verifies the executables, runtime and server tree against the manifest and against digests built into `mfw`, and runs the bundle with no `bunfig.toml` or `.env` | `packages/cli/src/compiled-deps.ts` |
| Internal subcommands | `mfw __host` is refused from source, inside an mfw sandbox (by its read-only mount points), and from the launcher's subtree. This keeps a confused caller out; the sandbox is the boundary | `packages/cli/src/host-exec.ts` |
| Host spawn environment | every process the host starts that is `mfw`, bun or another compiled bun executable gets an allowlisted environment: a fixed base, `MFW_*`, and the launch's declared provider and secret names. `BUN_*`, `NODE_*`, `LD_*`, `DYLD_*`, `GLIBC_TUNABLES` and the shell start-up variables never pass, and a launch that declares one is refused. `run.sh` starts the driver under `env -i` with the same list. A test fails on any spawn in such a file that inherits its environment | `packages/daemon/src/containment/host-spawn-env.ts`, `packages/daemon/test/host-spawn-env.test.ts` |
| Built migrations | applied from the build, hash-checked at each open. A compiled `mfw` applies only its embedded copy, with the same check | `packages/db/src/migration-source.ts`, `tools/build-migrations.ts`, `tools/compile.ts` |
| Native addon | the libsql addon is embedded in `mfw`, hash-checked and loaded from a fresh private directory, then removed | `packages/cli/src/native-addon.ts` |
| Source-run guard | a server run from source refuses to manage its own checkout | `packages/daemon/src/containment/source-run-guard.ts` |
| Trigger arming | a repository trigger is inert until the owner arms it. The record lives outside every repository | `packages/daemon/src/triggers/arming.ts` |
| Execution pin | an armed command is tied to its commit's whole tree and runs from a sealed checkout | `packages/daemon/src/containment/exec-pin.ts`, `packages/daemon/src/triggers/script-action.ts` |

### 8. The brain

| Control | Mechanism | Code |
| --- | --- | --- |
| Decision rights | a fixed table of what the brain decides, reports or must ask | `packages/daemon/src/brain-runtime/decision-rights.ts` |
| Taint | a session that read agent or external text stays tainted, and sensitive actions become owner cards | `packages/daemon/src/brain-runtime/provenance.ts` |
| Act breaker | repeated failures, excess acts or spend pause the brain's act tools | `packages/daemon/src/brain-runtime/act-breaker.ts` |
| Attention budget | caps how many asks reach the owner, without dropping them | `packages/daemon/src/act-budget.ts` |
| Read-only chat | chat has read tools only and its own budget | `packages/daemon/src/brain-runtime/chat-tools.ts`, `packages/daemon/src/brain-runtime/chat-budget.ts` |
| Bound socket | each turn has its own socket and token, bound to one project and turn | `packages/daemon/src/brain-runtime/brain-socket.ts` |
| Transcript check | a resumed transcript must match the hash the host recorded | `packages/daemon/src/containment/brain-transcript.ts` |
| Critic | runs in the reviewer sandbox with no tools. Transports without that mode are refused | `packages/daemon/src/critic-inference.ts` |
| Typed claims | "verified", "merged" and similar words render as fact only with host evidence | `packages/daemon/src/claims.ts`, `packages/daemon/src/claims-evidence.ts` |

### 9. Network clients to the control plane

| Control | Mechanism | Code |
| --- | --- | --- |
| Owner auth | setup token, argon2id password, revocable server-side sessions, throttling | `packages/daemon/src/auth/service.ts` |
| Passkeys | The library `@simplewebauthn/server` 14.1.0 parses every response and verifies every signature. With mfw's options it checks the challenge, the exact origin and RP ID, user presence and verification, and that the key's `alg` label is ES256 or EdDSA (the label only). mfw's own checks, in `webauthn.ts`: the whole key shape at registration and every sign-in (ES256 must be EC2 P-256 with 32-byte coordinates, EdDSA must be OKP Ed25519 with a canonical key not of small order, since the library picks its verifier by key type and verifies signatures anyone can forge for small-order keys); attestation only `none` or `packed` without `x5c`, never trusted; no cross-origin frames on either ceremony; the reported credential id must match the authenticator data; no private key component; and a counter-regression refusal applied after the signature verifies. In `service.ts` and `passkeys.ts`: discoverable credentials only (`credProps.rk` must be reported and true, the browser's unsigned word), sign-in options that never list credentials, the RP ID and origin from the trusted external origin, single-use short-lived challenges capped per source and per IPv6 /48, and the password's throttle | `packages/daemon/src/auth/webauthn.ts`, `packages/daemon/src/auth/passkeys.ts`, `packages/daemon/src/auth/service.ts`, `apps/start/src/server/passkey-origin.ts` |
| Request guard | exact Host and Origin checks | `apps/start/src/server/request-guard.ts` |
| Session guard | cookie plus a per-session request key, because cookies are shared across ports | `apps/start/src/server/auth-guard.ts` |
| Bind policy | non-loopback needs TLS or a trusted proxy, and wildcard binds are refused | `apps/start/src/server/exposure.ts` |
| Trusted proxy | forwarded headers are honoured only from named peers | `apps/start/src/server/trusted-proxy.ts`, `apps/start/src/server/unix-listener.ts` |
| Scoped tokens | four closed scopes, hashed storage, expiry, audit. No scope reaches settings, triggers, merges or approvals | `packages/daemon/src/auth/tokens.ts`, `packages/api/src/token-access.ts` |
| Browser hardening | nonce-based CSP, with file routes served under `sandbox` | `apps/start/src/server/security-headers.ts` |

### 10. Project dev environments

The evaluation of a project's environment and the install of its dependencies
are **the one place mfw runs project code with network**. What limits them
([environments.md](environments.md)):

| Control | Mechanism | Code |
| --- | --- | --- |
| Owner approval per commit | evaluation runs only at a commit the owner allowed (`mfw env allow` or a card). The approval records every environment file's sha256, the lockfiles with `setup`, and the hash of the project's `env` config; a later commit is covered only while all of them are byte-identical | `packages/daemon/src/containment/dev-env-trust.ts`, `dev-env-sources.ts` |
| Read, not evaluated, on the host | the host reads the files' blobs from the primary's object store. Symlinked or submodule environment files are refused | `packages/daemon/src/containment/dev-env-sources.ts` |
| The same launch chain | `env-build` and `env-install` roles go through profile, compile, probe, attestation and the single-use gate. Their ceilings forbid agent config, credentials and a writable gitdir; only `env-build` may reach the nix daemon | `packages/daemon/src/containment/dev-env-build.ts`, `profile.ts`, `role-profiles.ts` |
| Disposable clone, private home | the approved commit alone (no history), deleted afterwards. `direnv allow` and `mise trust` write the sandbox's tmpfs home, never the host's | `packages/daemon/src/containment/dev-env-build.ts` |
| Egress allowlist | the per-run proxy with exact `host:port` lists derived from what the fixtures contacted: flake inputs and mise for an evaluation, the registries for an install. Refused hosts are recorded host-side | `packages/daemon/src/containment/dev-env-egress.ts` |
| Untrusted nix client | the evaluation is refused when the daemon trusts the user, or does not say, checked on the host before anything runs and again in the sandbox before the first project file is read | `packages/daemon/src/containment/dev-env-build.ts` |
| Bounds | a wall-clock deadline, the role's task and memory limits, and polled size caps on the tree, the data directory and the outbox | `packages/daemon/src/containment/dev-env-build.ts`, `check-tree-cap.ts` |
| The result is data | each tool's JSON export is parsed, never a script. Loader and runtime names are dropped, values are capped, and `PATH` keeps only the environment's store closure, its data and the run's tree. The profile schema checks it again at every launch | `packages/daemon/src/containment/dev-env-capture.ts`, `dev-env-rules.ts`, `profile.ts` |
| Read-only in runs | the store closure and the environment's data are bound read-only, path by path; the rest of the store stays hidden | `packages/daemon/src/containment/compile-bwrap.ts` |
| Changes are ask-first | a merge that changes an environment file, `flake.lock`, `devenv.lock`, or a file the approval covers (a sourced file, a lockfile with `setup`) waits on a card, and then the approval no longer covers the base | `packages/daemon/src/merge-gate.ts`, `packages/daemon/src/brain-runtime/decision-rights.ts` |

## Attacker models

### A hostile agent, or prompt injection in repository content

**Goal:** escape, steal credentials, persist, or land malicious code.

- **Stopped:** reading the home directory or `$MFW_HOME`, writing to the primary
  repository, reaching host sockets, planting git config or hooks that the host
  runs, forging a passing check, and forging "verified" in the UI.
- **Limited:** sending data out (allowed hosts, within the budget), and misleading
  the brain (sensitive actions become cards once it is tainted).
- **Still possible:** see R2, R3, R8 and R10. An injected brain can still dispatch
  work, control runs, edit the board and select a merge winner, because those
  actions stay allowed after reading untrusted text. What they start remains inside
  the sandbox and the merge gates.

### A malicious dependency

**Goal:** run code at install, build or test time.

- **Stopped:** in a sandboxed run or check it has the same limits as the agent.
  Checks have no network. Trigger dependencies install from the lockfile with
  lifecycle scripts off, before any secret is read.
- **Limited:** a change to an executing `package.json` field needs an approval.
- **Limited further with `env.setup`:** dependencies are installed once per
  approval, in the `env-install` sandbox, where lifecycle scripts run with
  registry egress only. The lockfiles are part of the approval, so a changed
  lockfile waits on a card and is installed only after you allow the commit.
- **Still possible:** without `env.setup`, a changed lockfile or dependency
  version is a notify-after item and does not wait for approval. A lifecycle
  script in the install sandbox can send the approved commit's code to an
  allowed registry (R21). Malicious code that lands runs with your rights when
  you build or run the project outside mfw (R8).

### A hostile environment file

**Goal:** run code with network, or on the host, through `.envrc`, `mise.toml`,
`flake.nix` or what they source.

- **Stopped:** nothing is evaluated on the host. A run's edit to its own
  `.envrc` is never evaluated: runs and checks get the approved environment.
  The edit is evaluated only after it merges (an ask-first card) and you allow
  that commit. In the sandbox the file cannot read your home or write outside
  its clone, and what it starts dies with the sandbox. `LD_PRELOAD`,
  `NODE_OPTIONS` and similar exports never reach a run.
- **Limited:** at an approved commit it runs with egress to the allowlisted
  hosts, can ask the nix daemon to build or fetch (R20), and its exported
  variables and dev-shell tools reach every run and check.
- **Still possible:** what you approve runs. Read the files `mfw env allow`
  lists before you approve them.

### A local process sharing loopback

**Goal:** sign in, lock the owner out, or impersonate a client.

Sandboxed runs are not in this group, because each has its own network namespace.
This group is any other process of any local user, an unsandboxed
`agentIsolation: "none"` run, an armed host trigger and a notify command.

- **Stopped:** using the API without a session and request key, and escaping the
  throttle by rotating `127.x` addresses (all of loopback is one bucket).
- **Still possible:** password guessing at the throttled rate, and slowing or
  locking out the owner's sign-in (`mfw auth unlock` clears it). If you set
  `MFW_TRUSTED_PROXIES=127.0.0.1`, such a process can also claim any client
  address. Use the private unix socket instead (R1).

### A tailnet peer

**Goal:** reach the UI from another device.

- **Stopped:** by default the server listens on loopback only. Behind a proxy,
  exact Host checks, sign-in and per-address throttling apply.
- **Still possible:** any device that can reach the published port can try to sign
  in, so use a long random passphrase and keep Funnel off. The Tailscale path has
  not been run against a real `tailscale serve` (R13).

### A stolen session or token

- **Owner session:** treat this as code execution on the host. An owner can set
  notify commands, check prefixes and merge checks, arm triggers, and approve
  cards. Revoke with `mfw auth sign-out-everywhere`, or change the password.
  A stolen session cannot add a passkey: that needs the password again. If the
  password is stolen too and a passkey is added, the log and a banner in every
  other session say so, Settings shows the address it came from, and both
  sign-out-everywhere and a password change delete it. A stolen session can
  revoke passkeys; each revocation is announced the same way.
- **Passkey:** a synced passkey is as safe as the account that syncs it. Revoke
  it with `mfw auth passkey revoke`, which also ends the sessions it opened and
  revokes the API tokens those sessions created.
- **Scoped token:** limited to its scopes and project until it expires. A
  `board:write` token cannot cause work to start, and its text is permanently
  marked untrusted. A `runs:act` token can start and stop task runs. Revoke with
  `mfw auth token revoke`.
- **Agent CLI login:** see R2. The response is to log that fleet directory out
  with the vendor's tools.

### A malicious provider or plugin

mfw has no third-party plugin loader. Resources and targets are built in, and
`packages/plugin-api` only defines their contracts.

- **Agent CLIs and model providers** are trusted to run as the sandboxed agent.
  A compromised CLI is contained like a hostile agent, but it holds its own login
  and can talk to its allowed hosts. A malicious model response is prompt injection.
- **Reported data is not trusted.** Usage, rate limits and errors from a run are
  tagged `sandbox-reported`. They do not feed budget hard stops, and a hold taken
  from one is clamped and scoped (`packages/daemon/src/provider-holds.ts`).
- **ACP agents have no sandbox profile.** A sandboxed launch refuses them, so they
  run only with `agentIsolation: "none"` and interactive approval, as your user.
- **OpenAI-compatible endpoints and OpenRouter** receive the prompts and code sent
  to them.

## Residual risks

These are known and accepted for now. Each is stated so you can decide whether it
is acceptable for your setup.

| # | Risk | Effect | What limits it today |
| --- | --- | --- | --- |
| R1 | **Shared loopback outside the sandbox.** Sandboxed runs have a private network namespace. Unsandboxed runs, host triggers, notify commands and other local processes do not | Password guessing, sign-in lockout, and forged clients if a loopback proxy is trusted | One loopback throttle bucket, `mfw auth unlock`, the private unix socket |
| R2 | **The fleet login is readable by agents.** A run needs its CLI's token and can use it against allowed hosts | Vendor account use or theft of that login | Dedicated fleet directory, egress allowlist, logging out the fleet login |
| R3 | **Uploads to allowed hosts are bounded, not blocked.** Vendor APIs accept other accounts' keys, and read-only roles have egress too | Code or the token can leave, up to the budget | Per-run budgets (1 GiB and 2 GiB, not calibrated), host-observed ledger |
| R4 | **The TLS check stops at the hello.** A `Host` header inside TLS is invisible | A shared CDN might route a matching hello to another site | SNI must match, exact host list. Not tested against real CDNs |
| R5 | **Codex's own sandbox is not a boundary here.** The bridge asks for `workspace-write`, and the outer sandbox disables nested user namespaces, which made Codex's shell calls fail in earlier experiments | Codex task runs may not work, and its inner sandbox adds no protection | `bwrap` is the boundary, and results are verified on the host. Not retested with a real CLI |
| R6 | **Systemd limits are unproven in CI.** CI installs no `bwrap` and does not require the live suites, so they skip there | A regression in the scope chain would not fail CI | Autonomous launches refuse without a scope. The live gate exists for hosts that have one |
| R7 | **Worktree mode is legacy.** It remains the configured default, and sandboxed runs refuse it. It works only unsandboxed and interactive, with checks on the host | A project left on the default starts no runs, and choosing `none` removes the sandbox | The inbox names the exact fix |
| R8 | **Merged code runs later.** Ordinary source and dependency changes that pass their checks merge and, with `pushOnMerge` on by default, push without a card | Hostile code that passes checks reaches the branch, the remote, and your machine when you run it | Ask-first paths, verification, review settings. Set `pushOnMerge: false` to keep merges local |
| R9 | **Armed triggers are host commands.** A pinned script can do anything you can, and tools on `PATH` are checked for location only | Whatever the armed command does | Owner arming, whole-tree pin, sealed checkout |
| R10 | **Same user, shared kernel.** The sandbox runs as your uid | A kernel or `bwrap` flaw is an escape. Any process already outside the sandbox can read `auth.db` and `mcp-token` | Namespaces, seccomp, no capabilities. There is no VM tier yet |
| R11 | **The toolchain is not an execution boundary.** `bun` and `node` run any code, a run can execute what it writes, and non-NixOS hosts bind `/usr` whole | More tools are available inside the sandbox | Namespace and proxy limit where that code can reach |
| R12 | **Resource exhaustion remains possible.** Task clones have no disk quota, the check disk cap is polled, and the proxy has no memory limit of its own | Full disk or memory pressure on the host | Scope limits, per-run output cap, connection and proxied-run caps |
| R13 | **The Tailscale path is untested** against a real `tailscale serve` | A proxy mismatch could break sign-in or forwarded-address handling | Strict header parsing, `tools/tailscale-serve-check.sh` |
| R14 | **A check proves only what it runs.** Candidate code can detect the sandbox and behave differently | A passing check is not proof of safety | Host-observed exit codes, ask-first paths |
| R15 | **Browser origin.** Script on the mfw origin could read the request key, and a sibling HTTPS port on the same name can sign you out | Session misuse, or a nuisance sign-out | CSP, nothing rendered as raw HTML, and a dedicated origin ([exposure.md](exposure.md)) |
| R16 | **The fleet write allowlist is provisional** (`unattested-config`) and has not been audited against authenticated CLIs. Files in the config root are read-only, which may stop a CLI saving a refreshed login | Runs may fail on login refresh | Per-run private session directories |
| R17 | **Token rate limits live in memory** and reset on restart | A short extra burst after a restart | Scopes, expiry, audit log |
| R18 | **A compiled bun executable cannot refuse its runtime variables.** `BUN_OPTIONS` preloads code before `mfw`'s own code runs, `BUN_BE_BUN` turns `mfw` into a plain bun, and `LD_PRELOAD` loads a library into it. Bun offers no build option to turn them off | Code runs with the rights of whoever started `mfw` with them set | Every host spawn gets the allowlisted environment, so the daemon never passes them. The one exposure left is a process the daemon does not start, such as your own shell or a unit you wrote running `mfw` with one set: that code runs with your own rights |
| R20 | **The nix daemon acts outside the proxy.** An evaluation needs the daemon's socket, and the daemon substitutes, fetches and builds with its own network and configuration. A fixed-output derivation fetches any URL | An approved evaluation can send what it can read (the approved commit's tree, and the whole store, which it sees read-only) to any host through a derivation's URL, fill the store, and ask the daemon to collect garbage, which deletes store paths no root holds | The daemon must not trust the user (no unsigned imports, no own substituters, no garbage collection that ignores roots); builds run in the daemon's sandbox; only an approved commit is evaluated; each cached environment holds GC roots, and a run whose closure is gone is refused, never given less |
| R21 | **Allowed hosts are reachable from project code.** An evaluation reaches GitHub and mise's hosts, an install the registries | The approved commit's code, or anything the evaluation computed, can leave to those hosts | Exact host lists, upload budget, host-observed record, the approval |
| R22 | **The approved environment shapes every run.** Its tools and variables are on every run's and check's `PATH`. The variable filter drops loader and runtime names, but a tool on `PATH` can be anything the approved shell put there | A check passes or fails by what the approved environment provides | The approval and its files are shown before you allow; drift asks again |
| R23 | **The environment cache is host-trusted.** `$MFW_HOME/env/cache` holds the evaluated environment and the installed dependencies, re-validated at each launch but not hashed | Someone who can write `$MFW_HOME` can change what runs get | `$MFW_HOME` is outside every sandbox; the schema re-checks variables and paths at each launch |
| R19 | **The install manifest is unsigned, and checked then used by path.** It proves the parts belong together, not who made them, and a file renamed between its hash and its start is not caught. Server code loaded lazily is trusted once the server has started | Someone who can write the install can replace any part of it | The location check: root-owned or Nix-store installs only, or the owner's explicit acceptance of the prefix |
| R20 | **Passkey challenges live in memory, in one bounded pool.** A trusted loopback proxy lets a local process forge clients and keep the proxied share full. Without a proxy, a directly exposed listener can be filled by an attacker with many addresses: IPv4 addresses, or IPv6 prefixes beyond one /48 | Passkey sign-in is delayed (`busy`) while the flood lasts; password sign-in is not, and stays the fallback | 4 challenges per source, 16 per IPv6 /48, 128 for proxied clients, 1024 in all, a 2.5-minute expiry, and the private unix socket (R1) |

## Not yet verified

These protections exist in code but have not been exercised end to end:

- the full systemd scope chain on a real host, including a fork bomb, a memory
  limit and a failed scope stopping a launch;
- real Claude Code and Codex CLIs through the probe, launch, resume and import
  path under the full profile, including token refresh;
- a real `tailscale serve`, on two devices and over IPv6;
- passkeys on real authenticators and browsers other than Chrome (tested with
  Chrome's virtual authenticator and a software authenticator only);
- Ubuntu with its AppArmor user-namespace restriction, and distributions other
  than NixOS;
- the egress allowlist against what authenticated CLIs actually contact;
- case-insensitive filesystems, SHA-256 repositories and reftable primaries;
- the env-build and env-install roles under a real systemd scope: their task and
  memory limits, a real fork bomb, and a cache-cold evaluation of a large flake;
- dev environments on a non-NixOS host, mise tools that link against
  `/lib64/ld-linux`, `use nix` with a `<nixpkgs>` lookup, and the yarn, cargo and
  python registry entries, which no fixture installs from.

## Out of scope

- A compromised owner account, host, kernel, firmware, `bwrap`, git or agent CLI.
- Physical access, and backups you make of `$MFW_HOME`.
- Multiple users on one mfw install. mfw has a single owner.
- Vendors' handling of the prompts and code you send them.
- Attacks on your git remote or CI system themselves.
- macOS, Windows and aarch64 for autonomous runs: the seccomp filter is x86_64 only,
  and a host without it refuses them.
- Denial of service by someone who already has a valid owner session.
