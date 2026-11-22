import { constants } from "node:fs";
import {
	access,
	appendFile,
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "@mfw/core/fsatomic";
import {
	assertDisjointEnvironmentNames,
	SecretEnvironment,
} from "./execution-environment.ts";
import type { Logger } from "./log.ts";
import { runProc } from "./proc.ts";
import {
	type BwrapIsolation,
	bwrapAvailable,
	ensureTmuxSocketDir,
	pinnedTool,
	SANDBOX_ENV_ALLOWLIST,
	SandboxUnavailableError,
	safeHostPath,
	underPrivateTmp,
	wrapWithBwrap,
} from "./sandbox.ts";

/**
 * AgentHost v2: tmux mechanics only, no domain logic. Rows/state live in
 * RunRegistry; completion handling in the Supervisor. Run dir contract:
 *
 *   meta.json     written once by RunRegistry, never mutated
 *   events.jsonl  normalized AgentEvents, single writer: the driver process
 *   raw.log       verbatim pane output, tmux pipe-pane target
 *   exit          "exit:<code>" (run.sh) | "killed:<reason>" (kill, compare-and-skip)
 *   steer.jsonl   daemon appends (O_APPEND), driver reads
 *   control.jsonl daemon appends typed controls, shared app-server driver reads
 *   driver.json   invocation config for the driver
 *   run.sh        session wrapper (go-signal gate; writes `exit`)
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
const TMUX_ENV_NAMES = [...SANDBOX_ENV_ALLOWLIST, "TMUX_TMPDIR"];

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

export interface AgentHostOptions {
	tmuxRunner?: AgentTmuxRunner;
	/** Test seam for availability degradation (Bun module mocks are process-global). */
	sandbox?: {
		bwrapAvailable: typeof bwrapAvailable;
		wrapWithBwrap: typeof wrapWithBwrap;
	};
	/** Where secret FIFOs are made; defaults to the host-only control directory. Must be private and is masked inside every sandbox. */
	secretCarrierRoot?: string;
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
}

export class AgentHost {
	private readonly runTmux: AgentTmuxRunner;
	private readonly carrierRootOverride: string | null;
	private readonly secretHandoffTimeoutMs: number;
	private readonly secretHandoffWriter: AgentSecretHandoffWriter;
	private readonly sandbox: NonNullable<AgentHostOptions["sandbox"]>;

	constructor(_log?: Logger, opts: AgentHostOptions = {}) {
		this.runTmux = opts.tmuxRunner ?? tmux;
		this.sandbox = opts.sandbox ?? { bwrapAvailable, wrapWithBwrap };
		this.carrierRootOverride = opts.secretCarrierRoot ?? null;
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
		const root = join(tmpdir(), `mfw-control-${uid}`);
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
		const dir = spec.runDir;
		const control = await this.controlRoot();
		const scriptPath = join(control, `run-${spec.runId}.sh`);
		const rawLog = join(dir, "raw.log");
		const exitPath = join(dir, "exit");

		const publicEnvironment = spec.env ?? {};
		const secretEnvironment =
			spec.secretEnvironment ?? new SecretEnvironment({});
		assertDisjointEnvironmentNames(publicEnvironment, secretEnvironment);
		if (
			SECRET_HANDOFF_SENTINEL in publicEnvironment ||
			secretEnvironment.names().includes(SECRET_HANDOFF_SENTINEL)
		) {
			throw new Error("launch environment uses a reserved internal name");
		}

		await writeFileAtomic(
			join(dir, "driver.json"),
			JSON.stringify(
				{
					argv: spec.agentArgv,
					bridgeArgv: spec.bridgeArgv ?? spec.agentArgv,
					providerArgv: spec.providerArgv ?? [],
					cwd: spec.cwd,
					env: publicEnvironment,
					model: spec.model,
					reasoningEffort: spec.reasoningEffort ?? "medium",
					initialMessage: spec.initialMessage ?? "",
					steer: spec.steer,
					approvalMode: spec.approvalMode ?? "autonomous",
				},
				null,
				2,
			),
		);
		await writeFile(join(dir, "steer.jsonl"), "", { flag: "a" });
		await writeFile(join(dir, "control.jsonl"), "", { flag: "a" });
		await writeFile(rawLog, "", { flag: "a" });

		// .envrc trust gate: load direnv only if the worktree's .envrc is byte-identical
		// to the primary checkout's, closing the prompt-injection → direnv-allow → RCE chain.
		const rootEnvrc = join(spec.projectRoot, ".envrc");
		const envrcGate = [
			`if [ -f .envrc ] && command -v direnv >/dev/null 2>&1 && cmp -s .envrc ${q(rootEnvrc)}; then`,
			"  direnv allow . >/dev/null 2>&1",
			'  eval "$(direnv export bash 2>/dev/null)"',
			"fi",
		].join("\n");

		// Run the driver under bwrap when requested. Fail closed: a missing bwrap
		// is a refusal, never a silent unsandboxed launch. With a sandbox the
		// direnv gate runs INSIDE it (security review G3: `~/.config/direnv/direnvrc`
		// is agent-writable and must not be sourced by the host shell), after the
		// probe, so its exports reach the driver and the allowlist still holds for
		// everything inherited.
		let driverCmd = `bun run ${q(spec.driverScript)} ${q(dir)}`;
		if (spec.isolation) {
			if (!(await this.sandbox.bwrapAvailable())) {
				throw new SandboxUnavailableError(
					"isolation requested but `bwrap` is not on PATH",
				);
			}
			// Make sure the tmux socket dir exists so it is masked even on a first launch.
			ensureTmuxSocketDir();
			driverCmd = this.sandbox.wrapWithBwrap(
				`${envrcGate}\n${driverCmd}`,
				spec.cwd,
				dir,
				{
					...spec.isolation,
					hidePaths: [
						...spec.isolation.hidePaths,
						control,
						...(this.carrierRootOverride ? [this.carrierRootOverride] : []),
					],
				},
				[...Object.keys(publicEnvironment), ...secretEnvironment.names()],
				{
					// `/tmp` is private per sandbox: what a run legitimately needs from
					// there (its driver and the agent binaries) is bound back.
					readOnly: [
						spec.driverScript,
						...[
							...spec.agentArgv,
							...(spec.bridgeArgv ?? []),
							...(spec.providerArgv ?? []),
						].filter((a) => a.startsWith("/")),
					].filter(underPrivateTmp),
				},
			);
		}

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
					`  [ -f ${q(exitPath)} ] || printf 'exit:78' > ${q(exitPath)}`,
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
		const script = [
			"#!/usr/bin/env bash",
			// One brace group: bash parses it whole before running anything, so text
			// appended to this file later is never executed (security review G1).
			"{",
			"set +e",
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
			`cd ${q(spec.cwd)} || { printf 'exit:1' > ${q(exitPath)}; exit 1; }`,
			...(spec.isolation ? [] : [envrcGate]),
			...secretGate,
			driverCmd,
			"rc=$?",
			// compare-and-skip: never overwrite an exit the kill path already wrote
			`[ -f ${q(exitPath)} ] || printf 'exit:%s' "$rc" > ${q(exitPath)}`,
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
			spec.cwd,
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

		const piped = await this.runTmux([
			"pipe-pane",
			"-o",
			"-t",
			name,
			`cat >> ${q(rawLog)}`,
		]);
		if (piped.exitCode !== 0) {
			await this.abortLaunch(name, secretHandoff);
			throw new Error(`tmux pipe-pane failed: ${piped.stderr || piped.stdout}`);
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

	private async prepareSecretHandoff(
		secretEnvironment: SecretEnvironment,
		controlRoot: string,
	): Promise<SecretHandoff> {
		const directory = await mkdtemp(join(controlRoot, "mfw-driver-secret-"));
		const fifoPath = join(directory, "environment.fifo");
		const ackPath = join(directory, "reader-ready");
		try {
			const made = await runProc(["mkfifo", "-m", "600", fifoPath], {
				timeoutMs: 5_000,
			});
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
		const exitPath = join(runDir, "exit");
		try {
			await readFile(exitPath, "utf8"); // already recorded, keep it
		} catch {
			await writeFile(exitPath, `killed:${reason}`).catch(() => {
				// best-effort: reconcile classifies a missing exit as interrupted
			});
		}
	}

	/** Append one steering message (O_APPEND, no read-modify-write races). */
	async appendSteer(runDir: string, message: string): Promise<void> {
		await appendFile(
			join(runDir, "steer.jsonl"),
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
			join(runDir, "control.jsonl"),
			`${JSON.stringify(control)}\n`,
		);
	}

	async readExit(runDir: string): Promise<RunExit> {
		let s: string;
		try {
			s = (await readFile(join(runDir, "exit"), "utf8")).trim();
		} catch {
			return { kind: "running" }; // no exit recorded (yet)
		}
		const exit = /^exit:(\d+)$/.exec(s);
		if (exit) return { kind: "exit", code: Number(exit[1]) };
		const killed = /^killed:(.+)$/.exec(s);
		if (killed) return { kind: "killed", reason: killed[1] as string };
		return { kind: "running" };
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
