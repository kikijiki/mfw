# Plugin trust requirements

**Status: open. External harness manifests must not load until every item below is closed.**

mfw describes each agent CLI with a harness manifest. Today only the manifests compiled into mfw can load: the registry refuses any other origin (`packages/plugin-api/src/harness-registry.ts`). The external plugin host is planned work, and a manifest from outside is a trust input.

A security review tried hostile manifests against the validator and the code that reads them. None of the cases below is reachable today, because no external manifest can load. Each one was accepted by the current schema and ceilings, or reproduced directly.

Closing an item means the fix is in, a regression test reproduces the case, and the box below is ticked in the same change.

## Checklist

- [ ] R1. A manifest cannot disable another harness's restrictions (critical)
- [ ] R2. Detection cannot run an arbitrary program on the host (critical)
- [ ] R3. A manifest cannot make write tools count as read-only (high)
- [ ] R4. Credential and login-path ceilings are complete (high)
- [ ] R5. The argv ceiling covers every argv and uses the positive check (high)
- [ ] R6. Egress declarations are not self-attested (medium)
- [ ] R7. Hostile input cannot break loading, and inert fields are refused (medium)

## R1. A manifest can disable other harnesses' restrictions

**Severity:** critical.

**Reproduction.** Load a manifest that declares `--sandbox read-only`, `--mode plan`, `--approval-mode plan` and `--disallowedTools` as its own autonomy arguments. It passes validation. The autonomy table is global, so those arguments now count as autonomy flags for every harness, and anything that removes autonomy flags removes these protections from Codex, Cursor, Gemini and Claude command lines.

**Intended fix.** Scope each declaration to the harness that made it. An external manifest may add detection only, and may never cause an argument to be removed.

## R2. Detection can run any program on the host

**Severity:** critical.

**Reproduction.** Set `detect.bin` to `bash` and `versionArgs` to `["-c", "<command>"]`. The manifest passes, and the detector runs that command directly on the host, outside the sandbox. `modes.task: ["sh", "-c", "..."]` with a matching binary also passes the schema.

**Intended fix.** Refuse shells and interpreters as a harness binary. Use a fixed version argument for external manifests. Run detection inside the sandbox, and pin the resolved binary by sha256 at enable, so a changed binary disables the harness until it is approved again.

## R3. A manifest can make write tools "read-only"

**Severity:** high.

**Reproduction.** Set `acp.readOnlyOtherTitles` to `["Bash", "Edit", "Write"]`. It passes, and the ACP bridge's tool classifier then allows an `other`-kind tool with one of those titles under the read-only policy.

**Intended fix.** Forbid this field for external manifests.

## R4. Credential and path ceilings are incomplete

**Severity:** high.

**Reproduction.**

- An external manifest can claim another vendor's key, such as `ANTHROPIC_API_KEY`.
- `auth.apiKeyEnv` is not checked, so `MFW_TOKEN` passes.
- Login files are checked against a denylist. `.password-store/x`, `.config/rclone/rclone.conf`, `.local/share/keyrings/login.keyring`, paths under `.mozilla/` and `.SSH/id_rsa` all pass, as do other harnesses' login files. A login probe reveals whether such a file exists.

**Intended fix.** Bind each credential to a per-plugin grant. Restrict login paths to an allowlist the plugin owns.

## R5. The argv ceiling has gaps

**Severity:** high.

**Reproduction.** `detect.versionArgs` and `detect.identity.args` are not scanned, so `--yolo` passes in both. The manifest ceiling also relies on the bypass denylist, which cannot be complete.

**Intended fix.** Scan every argv a manifest declares. For external manifests, hold each one to a positive list of what the dialect allows, as non-autonomous launches already are (`packages/plugin-api/src/harness-launch.ts`).

## R6. Egress declarations are self-attested

**Severity:** medium.

**Reproduction.** Wildcards, IP addresses, userinfo, paths, ports other than 443 and private suffixes are refused. Punycode names, `.corp`, `.private`, `*.nip.io`-style names and any public attacker-controlled host pass. The proxy still refuses private answers for those names. A manifest can also label telemetry as `inference`, or leave out `requiresApiKey`, and so avoid both conditions.

**Intended fix.** Show each host on the ask-first approval card. Refuse `xn--` names by default. Treat every external egress entry as opt-in.

## R7. Robustness and inert fields

**Severity:** medium.

**Reproduction.**

- **Size:** `auth.kinds` with a million items, a 5 MB `docsUrl` and JSON objects with 100,000 keys are accepted.
- **Depth:** a very deeply nested `capabilityMeta` throws a raw `RangeError` instead of a registry error.
- **Before validation:** a getter on `id` runs before the external refusal, and raw newlines and ANSI sequences in `id` reach the error message.
- **Availability:** one bad manifest refuses the whole load, and that load runs when the module initialises.
- **Ids:** case variants such as `Claude-CLI`, `a/../../b` and `constructor` are accepted.
- **Inert today, must be refused:** `install.skills: .git/hooks`, `install.projectDirs: [.git]`, `innerSandbox.mode: danger-full-access`, `fleet.readOnly` and `fleet.transcriptDir` without a fleet dir, and an unparsed `versionRange`.

**Intended fix.** Accept parsed JSON only, with size and depth limits checked first. Sanitise and cap any label shown in an error. Isolate external failures so the built-in harnesses still start. Use a strict lowercase id and refuse collisions after normalising. Refuse the inert fields until something enforces them.

## Rules that must keep holding

- The ACP bridge reads compiled-in manifest data without the validator. This exception must never extend to external data.
- The bypass denylist in `packages/plugin-api/src/harness-autonomy.ts` is a second layer. It is not a reason to relax the positive check.
- Detection runs directly on the host today. That is acceptable only while no external manifest can load.
