import { constants } from "node:fs";
import {
	access,
	appendFile,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import type { AgentLaunchRequest } from "./containment/agent-launch.ts";
import {
	AGENT_BRIDGED_ENV,
	AGENT_LAUNCH_ENV,
	HOST_BUN_FLAGS,
} from "./containment/agent-launch-argv.ts";
import {
	DEV_SHELL_REFUSAL,
	needsDevShell,
} from "./containment/agent-preflight.ts";
import {
	AgentProfileError,
	cloneLayout,
	fleetPrivateState,
	withoutAutonomyFlags,
} from "./containment/agent-profile.ts";
import {
	BrainLaunchError,
	type BrainSandbox,
	prepareBrainSandbox,
} from "./containment/brain-launch.ts";
import { restoreBrainTranscript } from "./containment/brain-transcript.ts";
import { SANDBOX_PATHS } from "./containment/compile-bwrap.ts";
import {
	harnessAllowlist,
	harnessEgressEnv,
	usesApiKeyAuth,
} from "./containment/egress-allowlists.ts";
import {
	EgressCapacityError,
	PROXY_MAX_OPEN_FILES,
	prepareRunEgress,
} from "./containment/egress-run.ts";
import {
	isReadOnlyAgentRole,
	sandboxRoleOfKind,
} from "./containment/role-profiles.ts";
import {
	driverRunPaths,
	ensureRunDirLayout,
	HOST_BRIDGE_MARKER,
	runHostFilesDir,
} from "./containment/run-dir.ts";
import { readSmallRegularFile } from "./containment/safe-file.ts";
import {
	assertDisjointEnvironmentNames,
	SecretEnvironment,
} from "./execution-environment.ts";
import { git } from "./git.ts";
import type { Logger } from "./log.ts";
import { runProc } from "./proc.ts";
import type { ExitEvidence, ExitSource } from "./run-exit-evidence.ts";
import { createRoleClone } from "./run-workspace/role-clone.ts";
import { writeWipLaunchRequest } from "./run-workspace/wip-snapshot.ts";
import {
	type BwrapIsolation,
	bwrapAvailable,
	controlRootPath,
	pinnedTool,
	requireHostTool,
	SandboxUnavailableError,
	safeHostPath,
} from "./sandbox.ts";

/**
 * AgentHost v2: tmux mechanics only, no domain logic. Rows/state live in
 * RunRegistry; completion handling in the Supervisor. Run dir contract:
 *
 *   meta.json             written once by RunRegistry, never mutated
 *   raw.log               verbatim pane output, tmux pipe-pane target
 *   control/              host-written, read-only in the sandbox
 *     exit                "exit:<code>" (run.sh) | "killed:<reason>" (kill, compare-and-skip)
 *     steer.jsonl         daemon appends (O_APPEND), driver reads
 *     control.jsonl       daemon appends typed controls, app-server driver reads
 *     driver.json         invocation config for the driver
 *   outbox/               the only run path the sandbox can write: agent claims
 *     events.jsonl        normalized AgentEvents, written by the driver
 *
 * Only a sandboxed launch is split. An unsandboxed run (`isolation` unset) and
 * a run launched before the split keep these files flat in the run dir.
 * `run.sh` (the session wrapper) lives in the host-only control root.
 *
 * Task and repair runs use the host bridge (design "Bridge on the host"): the
 * driver and bridge stay on the host, outside the workspace, and start the
 * agent through `containment/agent-launch.ts`. Their `events.jsonl` and
 * `raw.log` stay in the host-only run root, and no agent byte reaches the tmux
 * pane. Other run kinds keep the interim sandbox around the driver until their
 * role profiles exist.
 */

/** POSIX single-quote for safe embedding in a generated shell script. */
function q(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Dedicated socket keeps agent runs out of the user's tmux server and cgroup. Tests set MFW_TMUX_SOCKET=mfw-test. */
const TMUX_SOCKET = process.env.MFW_TMUX_SOCKET || "mfw";

/**
 * Environment names the tmux server may be started with. The server's global
 * environment is inherited by every pane, so it must hold nothing secret (the
 * sandbox experiment E1: a canary in the daemon's env reached every run).
 * `TMUX_TMPDIR` only locates the socket.
 */
const TMUX_ENV_NAMES = [
	"PATH",
	"HOME",
	"LANG",
	"LC_ALL",
	"TZ",
	"TERM",
	"SHELL",
	"USER",
	"LOGNAME",
	"TMPDIR",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_CONFIG_HOME",
	"NIX_PATH",
	"NIX_PROFILES",
	"NIX_SSL_CERT_FILE",
	"SSL_CERT_FILE",
	"TMUX_TMPDIR",
];

/** The mfw tmux server is driven under `env -i`; per-run public values travel by `-e`. */
function tmuxEnv(source: NodeJS.ProcessEnv = process.env): string[] {
	return TMUX_ENV_NAMES.flatMap((n) => {
		// The pane command goes through `$SHELL -c`, which would read the user's
		// rc files (agent-writable): pin it to a plain sh (security review G3).
		const v =
			n === "PATH"
				? safeHostPath()
				: n === "SHELL"
					? (pinnedTool("sh") ?? "/bin/sh")
					: source[n];
		return typeof v === "string" ? [`${n}=${v}`] : [];
	});
}

async function tmux(args: string[]) {
	// Absolute, pinned paths (security review G4): never a `PATH` lookup an agent can steer.
	const env = pinnedTool("env");
	const tmuxBin = pinnedTool("tmux");
	if (!env || !tmuxBin) {
		throw new SandboxUnavailableError("env or tmux is not on a trusted PATH");
	}
	return runProc(
		// `-f /dev/null`: never read `~/.tmux.conf`, which an agent can write (`run-shell`).
		[
			env,
			"-i",
			...tmuxEnv(),
			tmuxBin,
			"-f",
			"/dev/null",
			"-L",
			TMUX_SOCKET,
			...args,
		],
		{ timeoutMs: 10_000 },
	);
}

export type AgentTmuxRunner = typeof tmux;
export type AgentSecretHandoffWriter = (
	handle: FileHandle,
	content: string,
) => Promise<void>;

const SECRET_HANDOFF_SENTINEL = "MFW_DRIVER_SECRET_HANDOFF_COMPLETE";

/**
 * Timing defaults for the per-run driver, persisted into driver.json. A test
 * seam: `tools/test-preload.ts` shortens the steer grace, which is a fixed
 * 1.5 s wait after every turn that a scripted agent never needs. Nothing in
 * production writes to it.
 */
export const driverTimings: { steerGraceMs?: number } = {};

export interface AgentHostOptions {
	tmuxRunner?: AgentTmuxRunner;
	/** Test seam for a host without bwrap (Bun module mocks are process-global). */
	sandbox?: { bwrapAvailable: typeof bwrapAvailable };
	/** Where secret FIFOs are made; defaults to the host-only control directory. Must be private and is masked inside every sandbox. */
	secretCarrierRoot?: string;
	/** The host-only control directory. Defaults to the per-user one; tests use a private one. */
	controlRoot?: string;
	/** Bound for run.sh to open and acknowledge the FIFO reader. */
	secretHandoffTimeoutMs?: number;
	/** Injectable only so failure tests can model EOF and truncated pipe writes. */
	secretHandoffWriter?: AgentSecretHandoffWriter;
}

interface SecretHandoff {
	directory: string;
	fifoPath: string;
	ackPath: string;
	handle: FileHandle;
	content: string;
}

export type RunExit =
	| { kind: "running" }
	| { kind: "exit"; code: number }
	| { kind: "killed"; reason: string };

export interface LaunchSpec {
	runId: string;
	runDir: string;
	cwd: string; // the run's worktree
	projectRoot: string; // primary checkout (for the .envrc trust check)
	driverScript: string; // absolute path; every run goes through a driver
	agentArgv: string[];
	bridgeArgv?: string[];
	providerArgv?: string[];
	/** Public launch values only; this object is persisted in driver.json. */
	env?: Record<string, string>;
	/** Never persisted in driver.json, tmux argv, or the generated run script. */
	secretEnvironment?: SecretEnvironment;
	model?: string;
	reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | "max";
	initialMessage?: string;
	steer: boolean; // declared capability; driver verifies via `hello`
	approvalMode?: "autonomous" | "interactive";
	/** Isolate the driver from the daemon home (trigger arming store, credentials.json). Fail closed: without `bwrap` on `PATH` the launch throws `SandboxUnavailableError`. */
	isolation?: BwrapIsolation;
	/** Selects the sandbox role (`ROLE_OF_KIND`). */
	runKind?: string;
	/** Names the fleet config of a host-bridged run. */
	providerId?: string;
}

/** What differs in a run whose driver stays on the host. */
interface HostBridge {
	/** The run's proxy, started by `run.sh` before the driver. */
	egress: { configPath: string; socketPath: string };
	requestPath: string;
	cwd: string;
	agentArgv: string[];
	bridgeArgv: string[];
	providerArgv: string[];
	env: Record<string, string>;
	/** A read-only role's private clone, removed when the run ends. */
	roleCloneRoot?: string;
	/** A brain turn's transcript, kept once its sandbox has exited. */
	brainTranscript?: {
		turnState: string;
		store: string;
		cli: "claude" | "codex";
	};
}

const EGRESS_PROXY_MAIN = join(
	import.meta.dir,
	"containment",
	"egress-proxy-main.ts",
);

const BRAIN_TRANSCRIPT_MAIN = join(
	import.meta.dir,
	"containment",
	"brain-transcript-main.ts",
);

/** 0.05 s each: how long `run.sh` waits for the proxy socket. */
const EGRESS_START_POLLS = 400;
/** 0.05 s each: past the proxy's hard exit deadline. */
const EGRESS_STOP_POLLS = 80;

const FLEET_CLI: Readonly<Record<string, "claude" | "codex">> = {
	"claude-cli": "claude",
	"codex-cli": "codex",
};

const exists = (path: string) =>
	lstat(path).then(
		() => true,
		() => false,
	);

/** A machine at its proxy cap refuses the launch like any missing sandbox. */
function refuseOverEgressCapacity<T>(prepare: () => T): T {
	try {
		return prepare();
	} catch (err) {
		if (err instanceof EgressCapacityError) {
			throw new SandboxUnavailableError(err.message);
		}
		throw err;
	}
}

/** True for a run clone this role can mount as it is. */
async function isPrivateClone(
	cwd: string,
	role: AgentLaunchRequest["role"],
): Promise<boolean> {
	if (role === "brain") return false;
	try {
		cloneLayout(await realpath(cwd));
		return true;
	} catch (err) {
		if (err instanceof AgentProfileError) return false;
		throw err;
	}
}

/** The commit a host-created worktree was checked out at. */
async function worktreeHead(cwd: string, projectRoot: string): Promise<string> {
	const head = await git(["rev-parse", "HEAD"], cwd);
	if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim();
	const primary = await git(["rev-parse", "HEAD"], projectRoot);
	if (primary.exitCode !== 0) {
		throw new SandboxUnavailableError(
			"cannot find a commit to seed the run from",
		);
	}
	return primary.stdout.trim();
}

export class AgentHost {
	private readonly runTmux: AgentTmuxRunner;
	private readonly carrierRootOverride: string | null;
	private readonly controlRootOverride: string | null;
	private readonly secretHandoffTimeoutMs: number;
	private readonly secretHandoffWriter: AgentSecretHandoffWriter;
	private readonly sandbox: NonNullable<AgentHostOptions["sandbox"]>;

	constructor(_log?: Logger, opts: AgentHostOptions = {}) {
		this.runTmux = opts.tmuxRunner ?? tmux;
		this.sandbox = opts.sandbox ?? { bwrapAvailable };
		this.carrierRootOverride = opts.secretCarrierRoot ?? null;
		this.controlRootOverride = opts.controlRoot ?? null;
		this.secretHandoffTimeoutMs = opts.secretHandoffTimeoutMs ?? 5_000;
		this.secretHandoffWriter =
			opts.secretHandoffWriter ??
			((handle, content) => handle.writeFile(content));
		if (
			!Number.isFinite(this.secretHandoffTimeoutMs) ||
			this.secretHandoffTimeoutMs <= 0
		) {
			throw new RangeError(
				"secretHandoffTimeoutMs must be positive and finite",
			);
		}
	}

	/**
	 * The host-only control directory: `run.sh` and the secret FIFOs live here,
	 * never in the run dir (which the agent can write) and never where another
	 * run can see them (security review G1/G2). It is masked inside every
	 * sandbox. Created 0700 and verified: owned by us, not a symlink.
	 */
	private async controlRoot(): Promise<string> {
		const uid = process.getuid?.() ?? 0;
		const root = this.controlRootOverride ?? controlRootPath(uid);
		await mkdir(root, { recursive: true, mode: 0o700 });
		const st = await lstat(root);
		if (
			st.isSymbolicLink() ||
			!st.isDirectory() ||
			st.uid !== uid ||
			(st.mode & 0o077) !== 0
		) {
			throw new Error(`control directory ${root} is not private to this user`);
		}
		return root;
	}

	session(runId: string): string {
		return `mfw_${runId}`;
	}

	/** Launch the driver in a fresh detached tmux session. The run dir (and meta.json) must already exist (RunRegistry.create). */
	async launch(spec: LaunchSpec): Promise<void> {
		// The single choke point (security review G5): every launch path, task or
		// not, lands here, so autonomy without isolation is refused here.
		if (
			(spec.approvalMode ?? "autonomous") === "autonomous" &&
			!spec.isolation
		) {
			throw new SandboxUnavailableError(
				"autonomous runs require a bwrap sandbox (agentIsolation is none)",
			);
		}
		if (spec.isolation && !(await this.sandbox.bwrapAvailable())) {
			throw new SandboxUnavailableError(
				"isolation requested but `bwrap` is not on PATH",
			);
		}
		if (spec.isolation && !sandboxRoleOfKind(spec.runKind)) {
			throw new SandboxUnavailableError(
				`${spec.runKind ?? "unnamed"} runs have no sandbox profile`,
			);
		}
		const dir = spec.runDir;
		// No sandbox means no boundary to split along.
		const hostFiles = spec.isolation ? ensureRunDirLayout(dir).control : dir;
		const control = await this.controlRoot();
		const scriptPath = join(control, `run-${spec.runId}.sh`);
		const rawLog = join(dir, "raw.log");
		const exitPath = join(hostFiles, "exit");
		// The authoritative exit record: host-only, never the agent-writable run dir (security review X9).
		const exitRecord = join(control, `exit-${spec.runId}`);
		await this.pruneControl(control);
		// A stale record from an earlier run that reused this id must not read as this run's exit.
		await rm(exitRecord, { force: true });
		// Likewise a `control/exit` left in a run dir that was flat, and writable, before.
		if (spec.isolation) await rm(exitPath, { force: true });

		const publicEnvironment = spec.env ?? {};
		const secretEnvironment =
			spec.secretEnvironment ?? new SecretEnvironment({});
		assertDisjointEnvironmentNames(publicEnvironment, secretEnvironment);
		if (
			SECRET_HANDOFF_SENTINEL in publicEnvironment ||
			secretEnvironment.names().includes(SECRET_HANDOFF_SENTINEL) ||
			[AGENT_LAUNCH_ENV, AGENT_BRIDGED_ENV].some(
				(name) =>
					name in publicEnvironment || secretEnvironment.names().includes(name),
			)
		) {
			throw new Error("launch environment uses a reserved internal name");
		}
		const bridge = spec.isolation
			? await this.prepareHostBridge(spec, control, secretEnvironment)
			: null;

		await writeFileAtomic(
			join(hostFiles, "driver.json"),
			JSON.stringify(
				{
					argv: bridge?.agentArgv ?? spec.agentArgv,
					bridgeArgv: bridge?.bridgeArgv ?? spec.bridgeArgv ?? spec.agentArgv,
					providerArgv: bridge?.providerArgv ?? spec.providerArgv ?? [],
					cwd: bridge?.cwd ?? spec.cwd,
					env: bridge?.env ?? publicEnvironment,
					model: spec.model,
					reasoningEffort: spec.reasoningEffort ?? "medium",
					initialMessage: spec.initialMessage ?? "",
					steer: spec.steer,
					approvalMode: spec.approvalMode ?? "autonomous",
					...(driverTimings.steerGraceMs !== undefined
						? { steerGraceMs: driverTimings.steerGraceMs }
						: {}),
				},
				null,
				2,
			),
		);
		await writeFile(join(hostFiles, "steer.jsonl"), "", { flag: "a" });
		await writeFile(join(hostFiles, "control.jsonl"), "", { flag: "a" });
		await writeFile(rawLog, "", { flag: "a" });
		if (bridge) {
			await writeFile(join(hostFiles, HOST_BRIDGE_MARKER), "1\n", {
				mode: 0o600,
			});
		}

		// The driver is host code next to agent-written files: bun must not read
		// any config or `.env` from around it. Its output goes to the log file and
		// never to the pane, so no agent byte reaches a terminal. The host never
		// evaluates a project's `.envrc`.
		const bunBin = pinnedTool("bun") ?? "bun";
		const driverCmd = bridge
			? `export ${AGENT_BRIDGED_ENV}=1 ${AGENT_LAUNCH_ENV}=${q(bridge.requestPath)}\n${[bunBin, ...HOST_BUN_FLAGS, "run", spec.driverScript, dir].map(q).join(" ")} >> ${q(rawLog)} 2>&1`
			: `${q(bunBin)} run ${q(spec.driverScript)} ${q(dir)}`;

		// Secrets never touch a regular file: write through a 0600 FIFO once run.sh
		// acknowledges its reader, then unlink. A crash leaves at worst an empty FIFO for the session trap.
		const secretHandoff = secretEnvironment.isEmpty()
			? null
			: await this.prepareSecretHandoff(
					secretEnvironment,
					this.carrierRootOverride ?? control,
				);
		const secretGate = secretHandoff
			? [
					"secret_handoff_failed() {",
					"  exec 9<&- 2>/dev/null",
					`  rm -rf ${q(secretHandoff.directory)}`,
					"  mfw_record_exit 'exit:78'",
					"}",
					"trap secret_handoff_failed EXIT HUP INT TERM",
					`exec 9< ${q(secretHandoff.fifoPath)} || exit 1`,
					`: > ${q(secretHandoff.ackPath)} || exit 1`,
					`unset ${SECRET_HANDOFF_SENTINEL}`,
					"set -a",
					". /dev/fd/9",
					"secret_source_rc=$?",
					"set +a",
					"exec 9<&-",
					`if [ "$secret_source_rc" -ne 0 ] || [ "\${${SECRET_HANDOFF_SENTINEL}:-}" != 1 ]; then`,
					"  secret_handoff_failed",
					"  trap - EXIT HUP INT TERM",
					"  exit 78",
					"fi",
					`unset ${SECRET_HANDOFF_SENTINEL} secret_source_rc`,
					`rm -rf ${q(secretHandoff.directory)}`,
					"trap - EXIT HUP INT TERM",
					"unset -f secret_handoff_failed",
				]
			: [];
		const egressStart = bridge
			? this.egressStartLines(bridge.egress, bunBin)
			: [];
		const script = [
			"#!/usr/bin/env bash",
			// One brace group: bash parses it whole before running anything, so text
			// appended to this file later is never executed (security review G1).
			"{",
			"set +e",
			// compare-and-skip: noclobber makes the open O_EXCL, so an exit that is already
			// recorded (the kill path's) wins and a link planted at the path is never followed.
			// The control-dir record is the authoritative one; the run-dir copy is for readers there.
			"mfw_record_exit() {",
			`  ( set -C; printf '%s' "$1" > ${q(exitRecord)} ) 2>/dev/null`,
			`  ( set -C; printf '%s' "$1" > ${q(exitPath)} ) 2>/dev/null`,
			"  return 0",
			"}",
			// The tmux server runs under `env -i`, so the pane's login shell rebuilds PATH from
			// system defaults (on NixOS, dropping the daemon's toolchain). PATH is public: restore it.
			// With a sandbox, the shell itself keeps only trusted PATH entries (an agent can
			// plant binaries in $HOME) and the full PATH goes to the sandbox (security review G4).
			...(spec.isolation
				? [
						`MFW_SANDBOX_PATH=${q(process.env.PATH ?? "/usr/bin:/bin")}`,
						`export PATH=${q(safeHostPath())}`,
					]
				: [`export PATH=${q(process.env.PATH ?? "/usr/bin:/bin")}`]),
			"IFS= read -r _ 2>/dev/null  # wait for go signal",
			`cd ${q(bridge ? dir : spec.cwd)} || { mfw_record_exit 'exit:1'; exit 1; }`,
			// Before the secret gate, so the proxy never inherits a secret.
			...egressStart,
			...secretGate,
			bridge ? `${driverCmd} 8>&-` : driverCmd,
			"rc=$?",
			// Closing the pipe stops the proxy, and its final counters land before the
			// exit does. Bounded: a stuck proxy must never hold up the run's exit record.
			// Nothing is signalled here. The proxy has its own hard deadline, and the
			// recovery sweep removes one that outlives it.
			...(bridge
				? [
						"exec 8>&-",
						"mfw_egress_wait=0",
						`while [ -n "$mfw_egress_ticks" ] && [ "$(mfw_proc_ticks "$mfw_egress_pid")" = "$mfw_egress_ticks" ] && [ "$mfw_egress_wait" -lt ${EGRESS_STOP_POLLS} ]; do`,
						"  mfw_egress_wait=$((mfw_egress_wait + 1))",
						"  sleep 0.05",
						"done",
					]
				: []),
			...(bridge?.brainTranscript
				? [
						[
							requireHostTool("env"),
							"-i",
							bunBin,
							...HOST_BUN_FLAGS,
							"run",
							BRAIN_TRANSCRIPT_MAIN,
							bridge.brainTranscript.turnState,
							bridge.brainTranscript.store,
							bridge.brainTranscript.cli,
						]
							.map(q)
							.join(" ")
							.concat(" >/dev/null 2>&1"),
					]
				: []),
			...(bridge?.roleCloneRoot
				? [`rm -rf -- ${q(bridge.roleCloneRoot)} 2>/dev/null`]
				: []),
			'mfw_record_exit "exit:$rc"',
			'exit "$rc"',
			"}",
			"",
		].join("\n");
		await writeFileAtomic(scriptPath, script);

		const name = this.session(spec.runId);
		const args = [
			"new-session",
			"-d",
			"-s",
			name,
			"-x",
			"220",
			"-y",
			"50",
			"-c",
			bridge ? dir : spec.cwd,
			"-e",
			"TERM=dumb",
		];
		for (const [k, v] of Object.entries(spec.env ?? {})) {
			if (v !== undefined && v !== null) args.push("-e", `${k}=${v}`);
		}
		const bashBin = pinnedTool("bash");
		if (!bashBin) {
			throw new SandboxUnavailableError("bash is not on a trusted PATH");
		}
		args.push(`${q(bashBin)} ${q(scriptPath)}`);

		// The tmux server exits with its last session; a dispatch in that window fails transiently. Retry briefly.
		let r = await this.runTmux(args);
		for (let attempt = 0; attempt < 3 && r.exitCode !== 0; attempt++) {
			const transient =
				/server exited|no server running|failed to connect/i.test(
					r.stderr || r.stdout,
				);
			if (!transient) break;
			await Bun.sleep(100 * (attempt + 1));
			r = await this.runTmux(args);
		}
		if (r.exitCode !== 0) {
			await this.disposeSecretHandoff(secretHandoff);
			throw new Error(`tmux new-session failed: ${r.stderr || r.stdout}`);
		}

		if (!bridge) {
			const piped = await this.runTmux([
				"pipe-pane",
				"-o",
				"-t",
				name,
				`cat >> ${q(rawLog)}`,
			]);
			if (piped.exitCode !== 0) {
				await this.abortLaunch(name, secretHandoff);
				throw new Error(
					`tmux pipe-pane failed: ${piped.stderr || piped.stdout}`,
				);
			}
		}
		const go = await this.runTmux(["send-keys", "-t", name, "", "Enter"]);
		if (go.exitCode !== 0) {
			await this.abortLaunch(name, secretHandoff);
			throw new Error(`tmux send-keys failed: ${go.stderr || go.stdout}`);
		}

		if (secretHandoff) {
			try {
				await this.waitForSecretReader(secretHandoff.ackPath);
				// Both endpoints hold fds; unlink the path before any secret byte is written.
				await rm(secretHandoff.directory, { recursive: true, force: true });
				await this.secretHandoffWriter(
					secretHandoff.handle,
					secretHandoff.content,
				);
				await this.disposeSecretHandoff(secretHandoff);
			} catch {
				await this.abortLaunch(name, secretHandoff);
				throw new Error("driver secret handoff failed before consumption");
			}
		}
	}

	/**
	 * Start the run's proxy on a pipe from this script, and wait for its socket.
	 * The proxy gets an empty environment. If it never listens the run ends with
	 * the sandbox's refusal status and no agent starts.
	 */
	private egressStartLines(
		egress: HostBridge["egress"],
		bunBin: string,
	): string[] {
		const env = pinnedTool("env");
		if (!env) {
			throw new SandboxUnavailableError("env is not on a trusted PATH");
		}
		const proxy = [
			env,
			"-i",
			bunBin,
			...HOST_BUN_FLAGS,
			"run",
			EGRESS_PROXY_MAIN,
			egress.configPath,
		]
			.map(q)
			.join(" ");
		return [
			// Field 22 of /proc/<pid>/stat, empty for a zombie or a missing process.
			// With the pid it identifies one process, so a reused pid never matches.
			"mfw_proc_ticks() {",
			"  local line fields",
			'  { IFS= read -r line < "/proc/$1/stat"; } 2>/dev/null || return 1',
			`  fields=$\{line##*) }`,
			"  set -f",
			"  set -- $fields",
			"  set +f",
			'  [ "$1" != Z ] || return 1',
			`  printf '%s' "$\{20}"`,
			"}",
			// No memory or task limit: `ulimit -v` breaks bun, and a host without a
			// user manager has no scope to give it. See docs/egress.md.
			`exec 8> >(ulimit -n ${PROXY_MAX_OPEN_FILES}; exec ${proxy} >/dev/null 2>&1)`,
			"mfw_egress_pid=$!",
			'mfw_egress_ticks=$(mfw_proc_ticks "$mfw_egress_pid")',
			"mfw_egress_wait=0",
			`until [ -S ${q(egress.socketPath)} ]; do`,
			"  mfw_egress_wait=$((mfw_egress_wait + 1))",
			`  if [ "$mfw_egress_wait" -gt ${EGRESS_START_POLLS} ] || [ -z "$mfw_egress_ticks" ] || [ "$(mfw_proc_ticks "$mfw_egress_pid")" != "$mfw_egress_ticks" ]; then`,
			"    exec 8>&-",
			"    mfw_record_exit 'exit:78'",
			"    exit 78",
			"  fi",
			"  sleep 0.05",
			"done",
		];
	}

	/**
	 * The launch request and driver settings of a host-bridged run. Everything
	 * the agent sees uses sandbox paths, and an interactive run never carries an
	 * autonomous flag. Refuses rather than falling back to the interim sandbox.
	 */
	private async prepareHostBridge(
		spec: LaunchSpec,
		control: string,
		secretEnvironment: SecretEnvironment,
	): Promise<HostBridge> {
		const mfwHome = spec.isolation?.mfwHome;
		const cli = FLEET_CLI[spec.providerId ?? ""];
		if (!mfwHome || !cli) {
			throw new SandboxUnavailableError(
				`provider ${spec.providerId ?? "(none)"} has no sandbox profile yet: sandboxed runs support claude-cli and codex-cli`,
			);
		}
		const runDir = await realpath(spec.runDir);
		const stateDir = dirname(dirname(runDir));
		if (basename(dirname(runDir)) !== "runs") {
			throw new SandboxUnavailableError(
				`run dir ${runDir} is not in a project's runs directory`,
			);
		}
		const role = sandboxRoleOfKind(spec.runKind);
		if (!role) {
			throw new SandboxUnavailableError(
				`${spec.runKind ?? "unnamed"} runs have no sandbox profile`,
			);
		}
		const readOnly = isReadOnlyAgentRole(role);
		// Only a role that builds needs the dev shell. Nothing here evaluates it.
		if (
			!readOnly &&
			(needsDevShell(spec.projectRoot) || needsDevShell(spec.cwd))
		) {
			throw new SandboxUnavailableError(DEV_SHELL_REFUSAL);
		}
		if (!(await exists(join(stateDir, "mfw.db")))) {
			throw new SandboxUnavailableError(
				`no project database in ${stateDir}, so the launch cannot be attested`,
			);
		}
		const approvalMode = spec.approvalMode ?? "autonomous";
		const forMode = (argv: string[]) =>
			approvalMode === "autonomous" ? argv : withoutAutonomyFlags(argv);
		let agentArgv = forMode(spec.agentArgv);
		let providerArgv = forMode(spec.providerArgv ?? spec.agentArgv);
		const realHome = await realpath(mfwHome);
		let brain: BrainSandbox | null = null;
		if (role === "brain") {
			try {
				brain = await prepareBrainSandbox({
					runDir,
					mfwHome: realHome,
					cli,
					agentArgv,
					providerArgv,
				});
			} catch (err) {
				if (!(err instanceof BrainLaunchError)) throw err;
				throw new SandboxUnavailableError(err.message);
			}
			agentArgv = brain.agentArgv;
			providerArgv = brain.providerArgv;
		}
		const egressOptions = {
			telemetry: spec.isolation?.egressTelemetry === true,
		};
		const env = {
			...(spec.env ?? {}),
			...harnessEgressEnv(cli, egressOptions),
		};
		if ("MFW_REPORT_PATH" in env) {
			// A read-only role cannot write its workspace: it reports to the outbox.
			env.MFW_REPORT_PATH = `${readOnly ? SANDBOX_PATHS.runOutbox : SANDBOX_PATHS.workspace}/MFW_REPORT.json`;
		}
		const egressHome = await realpath(mfwHome);
		const egress = refuseOverEgressCapacity(() =>
			prepareRunEgress({
				mfwHome: egressHome,
				runDir,
				runId: spec.runId,
				allow: harnessAllowlist(cli, {
					...egressOptions,
					apiKeyAuth: usesApiKeyAuth(cli, [
						...Object.keys(spec.env ?? {}),
						...secretEnvironment.names(),
					]),
				}),
				...(spec.isolation?.egressUploadBudget
					? { uploadBudget: spec.isolation.egressUploadBudget }
					: {}),
			}),
		);
		// A brain's cwd is its scratch directory and a worktree's gitdir is in the
		// primary, so neither can be mounted: those get a private clone.
		let tree: string;
		let roleCloneRoot: string | undefined;
		if (readOnly && !(await isPrivateClone(spec.cwd, role))) {
			const rev =
				role === "brain"
					? "HEAD"
					: await worktreeHead(spec.cwd, spec.projectRoot);
			const clone = await createRoleClone(spec.projectRoot, spec.runId, rev);
			tree = clone.tree;
			roleCloneRoot = clone.root;
		} else {
			tree = await realpath(spec.cwd);
		}
		const request: AgentLaunchRequest = {
			version: 1,
			runId: spec.runId,
			role,
			approvalMode,
			cli,
			tree,
			runDir,
			projectRoot: await realpath(spec.projectRoot),
			stateDir,
			mfwHome: await realpath(mfwHome),
			env,
			secretNames: secretEnvironment.names(),
			egressSocketDir: egress.socketDir,
			...(brain ? { brainSocketDir: brain.brainSocketDir } : {}),
		};
		// Only a transcript whose hash still matches is carried in. Otherwise
		// `--resume` fails and the runtime starts a fresh generation.
		const brainTranscript = brain
			? {
					turnState: fleetPrivateState(tree, cli),
					store: brain.transcriptStore,
					cli,
				}
			: undefined;
		if (brainTranscript) {
			await restoreBrainTranscript(
				brainTranscript.store,
				brainTranscript.turnState,
			);
		}
		if (!readOnly) writeWipLaunchRequest(request);
		const requestPath = join(control, `agent-launch-${spec.runId}.json`);
		await rm(requestPath, { force: true });
		await writeFile(requestPath, JSON.stringify(request), {
			mode: 0o600,
			flag: "wx",
		});
		const bun = pinnedTool("bun") ?? process.execPath;
		const bridgeArgv = spec.bridgeArgv ?? agentArgv;
		return {
			egress: { configPath: egress.configPath, socketPath: egress.socketPath },
			requestPath,
			cwd: SANDBOX_PATHS.workspace,
			agentArgv,
			bridgeArgv:
				bridgeArgv[0] === "bun"
					? [bun, ...HOST_BUN_FLAGS, ...bridgeArgv.slice(1)]
					: bridgeArgv,
			providerArgv,
			env,
			...(roleCloneRoot ? { roleCloneRoot } : {}),
			...(brainTranscript ? { brainTranscript } : {}),
		};
	}

	private async prepareSecretHandoff(
		secretEnvironment: SecretEnvironment,
		controlRoot: string,
	): Promise<SecretHandoff> {
		const directory = await mkdtemp(join(controlRoot, "mfw-driver-secret-"));
		const fifoPath = join(directory, "environment.fifo");
		const ackPath = join(directory, "reader-ready");
		try {
			const made = await runProc(
				[requireHostTool("mkfifo"), "-m", "600", fifoPath],
				{
					timeoutMs: 5_000,
				},
			);
			if (made.exitCode !== 0) {
				throw new Error("could not create driver secret FIFO");
			}
			const handle = await open(fifoPath, constants.O_RDWR);
			const assignments = Object.entries(
				secretEnvironment.materializeForLaunch(),
			)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([name, value]) => `${name}=${q(value)}`)
				.join("\n");
			const content = `${assignments}\n${SECRET_HANDOFF_SENTINEL}=1\n`;
			return { directory, fifoPath, ackPath, handle, content };
		} catch (error) {
			await rm(directory, { recursive: true, force: true });
			throw error;
		}
	}

	private async waitForSecretReader(ackPath: string): Promise<void> {
		const deadline = Date.now() + this.secretHandoffTimeoutMs;
		while (Date.now() < deadline) {
			try {
				await access(ackPath);
				return;
			} catch {
				await Bun.sleep(10);
			}
		}
		throw new Error("driver secret reader acknowledgement timed out");
	}

	private async disposeSecretHandoff(
		handoff: SecretHandoff | null,
	): Promise<void> {
		if (!handoff) return;
		await handoff.handle.close().catch(() => {});
		await rm(handoff.directory, { recursive: true, force: true });
	}

	private async abortLaunch(
		sessionName: string,
		handoff: SecretHandoff | null,
	): Promise<void> {
		await this.disposeSecretHandoff(handoff);
		await this.runTmux(["kill-session", "-t", sessionName]).catch(() => {});
	}

	async isAlive(runId: string): Promise<boolean> {
		return (await this.sessionLiveness(runId)) === true;
	}

	/** Read-only tri-state liveness. Tool/permission failures are "unknown", never proof capacity is free. */
	async sessionLiveness(runId: string): Promise<boolean | null> {
		const r = await this.runTmux(["has-session", "-t", this.session(runId)]);
		if (r.exitCode === 0) return true;
		if (
			/no server running|can't find session|no sessions/i.test(
				`${r.stderr}\n${r.stdout}`,
			)
		) {
			return false;
		}
		return null;
	}

	/** Kill the whole session (process tree). Writes the reason to `exit` only if none is recorded, preserving a clean exit code. */
	async kill(runDir: string, runId: string, reason: string): Promise<void> {
		await this.runTmux(["kill-session", "-t", this.session(runId)]);
		const content = `killed:${reason}`;
		// Exclusive creates: an exit that already exists is kept, and a link or
		// FIFO planted at the path is never followed or read (security review X9).
		const create = async (path: string) => {
			try {
				const fh = await open(
					path,
					constants.O_WRONLY |
						constants.O_CREAT |
						constants.O_EXCL |
						constants.O_NOFOLLOW |
						constants.O_NONBLOCK,
					0o600,
				);
				try {
					await fh.writeFile(content);
				} finally {
					await fh.close();
				}
			} catch {
				// exists already, or best-effort: reconcile classifies a missing exit as interrupted
			}
		};
		await create(join(await this.controlRoot(), `exit-${runId}`));
		await create(join(runHostFilesDir(runDir), "exit"));
	}

	/** Append one steering message (O_APPEND, no read-modify-write races). */
	async appendSteer(runDir: string, message: string): Promise<void> {
		await appendFile(
			driverRunPaths(runDir).steer,
			`${JSON.stringify(message)}\n`,
		);
	}

	/** Append one typed control for the shared app-server driver. */
	async appendControl(
		runDir: string,
		control:
			| { type: "steer"; message: string }
			| { type: "interrupt" }
			| {
					type: "approval";
					requestId: string;
					decision: "accept" | "acceptForSession" | "decline" | "cancel";
			  },
	): Promise<void> {
		await appendFile(
			driverRunPaths(runDir).controls,
			`${JSON.stringify(control)}\n`,
		);
	}

	/**
	 * The recorded exit. For a run this host launched only the host-only record
	 * counts: the run dir copy is agent-writable, so a forged `exit:0` there must
	 * not read as completion while the session lives (security review X9). A run
	 * the control dir knows nothing about (an older launch, after a reboot) falls
	 * back to the run dir, read without following links or blocking.
	 */
	async readExit(runDir: string): Promise<RunExit> {
		return (await this.readExitEvidence(runDir)).exit;
	}

	/** The recorded exit and which record it came from (`run-exit-evidence.ts`). */
	async readExitEvidence(runDir: string): Promise<ExitEvidence> {
		const runId = basename(runDir);
		const control = await this.controlRoot();
		const authoritative = await readSmallRegularFile(
			join(control, `exit-${runId}`),
		);
		let s: string | null;
		let source: ExitSource;
		if (authoritative !== null) {
			s = authoritative;
			source = "host-exit-record";
			// The run script (host-only, no secrets) is done with.
			await rm(join(control, `run-${runId}.sh`), { force: true }).catch(
				() => {},
			);
			await rm(join(control, `agent-launch-${runId}.json`), {
				force: true,
			}).catch(() => {});
		} else if (
			await lstat(join(control, `run-${runId}.sh`)).then(
				() => true,
				() => false,
			)
		) {
			return { exit: { kind: "running" }, source: null };
		} else {
			// A split run's copy is host-written; the flat path of an older or remote
			// run is all there is for it. `exitProvenance` decides what each is worth.
			const hostFiles = runHostFilesDir(runDir);
			source = hostFiles === runDir ? "flat-exit" : "control-exit";
			s = await readSmallRegularFile(join(hostFiles, "exit"));
		}
		if (s === null) return { exit: { kind: "running" }, source: null }; // no exit recorded (yet)
		s = s.trim();
		const exit = /^exit:(\d+)$/.exec(s);
		if (exit) return { exit: { kind: "exit", code: Number(exit[1]) }, source };
		const killed = /^killed:(.+)$/.exec(s);
		if (killed) {
			return { exit: { kind: "killed", reason: killed[1] as string }, source };
		}
		return { exit: { kind: "running" }, source: null };
	}

	/** Old run scripts and exit records of long-finished runs; the control dir is not a log. */
	private async pruneControl(control: string): Promise<void> {
		const cutoff = Date.now() - 3 * 24 * 3600_000;
		try {
			for (const name of await readdir(control)) {
				if (!/^(run-.*\.sh|exit-.*|agent-launch-.*\.json)$/.test(name))
					continue;
				const p = join(control, name);
				const st = await lstat(p).catch(() => null);
				if (st && st.mtimeMs < cutoff) await rm(p, { force: true });
			}
		} catch {}
	}

	/** mfw_* sessions on our socket (reconcile input). */
	async listSessions(): Promise<string[]> {
		const r = await this.runTmux(["list-sessions", "-F", "#{session_name}"]);
		if (r.exitCode !== 0) return []; // no server running = no sessions
		return r.stdout
			.split("\n")
			.filter((s) => s.startsWith("mfw_"))
			.map((s) => s.trim());
	}
}
