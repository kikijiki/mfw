/**
 * Where a project's environment code runs: the env-build and env-install
 * sandboxes (design "Dev environment runs inside the sandbox"). This is the
 * one place mfw runs project code with network, so it takes the same single
 * path as every agent launch:
 *
 *   disposable clone -> profile -> compile -> probe -> attestation -> gate -> launch
 *
 * - The clone holds exactly the approved commit (`history: tip`) and is
 *   deleted afterwards. Nothing in it reaches the primary.
 * - Home is a private tmpfs, so `direnv allow` and `mise trust` record their
 *   trust there and never in the host's own state.
 * - Egress goes only through this call's proxy, with the env allowlist
 *   (dev-env-egress.ts); what it reached and what it was refused is recorded
 *   as host-observed evidence.
 * - The nix daemon's socket is bound for an evaluation only, and only when the
 *   daemon does not trust this user: a trusted client could add unsigned paths
 *   to the host's store or choose its own substituters.
 * - A wall-clock deadline, the role's task and memory limits, and size caps on
 *   the tree, the data directory and the outbox bound what it can consume.
 *
 * The entry script is mfw's, copied into the run's read-only control
 * directory. It calls the tool's own machine-readable export and writes it to
 * the outbox; the host parses it as untrusted data (dev-env-capture.ts).
 */

import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import { ingestRunEgress } from "../egress-ledger.ts";
import { VerifierClones } from "../run-workspace/verifier-clone.ts";
import {
	type LauncherSteps,
	protectedPaths,
	realLaunchSteps,
	withEgressRelay,
} from "./agent-launch.ts";
import { liveCompileHost } from "./agent-launch-host.ts";
import {
	AGENT_BASE_TOOLS,
	AgentProfileError,
	findWritableBindParent,
} from "./agent-profile.ts";
import { drainTail } from "./check-runner.ts";
import { watchTreeSize } from "./check-tree-cap.ts";
import { type CompileHost, compileBwrap } from "./compile-bwrap.ts";
import type { EnvSourceKind } from "./dev-env-sources.ts";
import type { AllowEntry } from "./egress-policy.ts";
import { prepareRunEgress } from "./egress-run.ts";
import { type EgressStats, parseEgressStats } from "./egress-stats.ts";
import { startRealProxy } from "./oneshot-agent.ts";
import {
	type DevEnvGrant,
	ProfileRejectedError,
	type SandboxProfile,
} from "./profile.ts";
import { buildEnvProfile, VERIFIER_TOOLS } from "./role-profiles.ts";
import {
	ensureRunDirLayout,
	RUN_CONTROL_DIR,
	runDirLayout,
} from "./run-dir.ts";
import { readRegularFile } from "./safe-file.ts";

/** The entry script's name in the run's control directory. */
export const ENV_ENTRY_FILE = "env-entry.sh";

/** The outbox file each step writes its export to. */
export const ENV_OUTPUT_FILE = "env.out";
export const ENV_LOG_FILE = "log";

/**
 * mfw's entry script. `$1` is the step. It sets the tools' private state under
 * the sandbox home, refuses a nix daemon that trusts this user before any
 * project file is read, then runs the tool. Output goes to the outbox; the
 * exit status is the tool's.
 */
export const ENV_ENTRY_SCRIPT = `#!/bin/sh
# mfw dev environment entry. Runs in the env-build or env-install sandbox.
set -u
out=/mfw-run/outbox
log="$out/${ENV_LOG_FILE}"
: >"$log"
cd /work || exit 120
data=/cache/env-data
export MISE_DATA_DIR="$data/mise" MISE_CACHE_DIR="$HOME/.cache/mise" \\
	MISE_CONFIG_DIR="$HOME/.config/mise" MISE_STATE_DIR="$HOME/.local/state/mise" \\
	MISE_YES=1 MISE_NOT_FOUND_AUTO_INSTALL=0 DIRENV_LOG_FORMAT='direnv: %s'
if [ -S /nix/var/nix/daemon-socket/socket ]; then
	info=$(nix store info --json 2>>"$log") || info=""
	case "$info" in
	*'"trusted":false'* | *'"trusted":0'*) ;;
	*)
		echo "mfw: the nix daemon trusts this user, or did not say: refusing to evaluate" >>"$log"
		exit 125
		;;
	esac
fi
step="$1"
shift
case "$step" in
direnv)
	direnv allow /work >>"$log" 2>&1 || exit 121
	exec direnv export json >"$out/${ENV_OUTPUT_FILE}" 2>>"$log"
	;;
mise)
	mise trust --all >>"$log" 2>&1 || exit 121
	mise install >>"$log" 2>&1 || exit 122
	exec mise env --json >"$out/${ENV_OUTPUT_FILE}" 2>>"$log"
	;;
flake)
	exec nix print-dev-env --json /work >"$out/${ENV_OUTPUT_FILE}" 2>>"$log"
	;;
devenv)
	exec devenv print-dev-env --json >"$out/${ENV_OUTPUT_FILE}" 2>>"$log"
	;;
setup)
	scripts="$1"
	shift
	if [ "$scripts" != on ]; then
		# Lifecycle scripts off: bun reads a global bunfig, npm, pnpm and yarn
		# classic npm_config_ignore_scripts, yarn berry YARN_ENABLE_SCRIPTS.
		mkdir -p "$XDG_CONFIG_HOME"
		printf '[install]\nignoreScripts = true\n' >"$HOME/.bunfig.toml"
		cp "$HOME/.bunfig.toml" "$XDG_CONFIG_HOME/.bunfig.toml"
		export npm_config_ignore_scripts=true YARN_ENABLE_SCRIPTS=false
	fi
	for cmd in "$@"; do
		echo "mfw: setup: $cmd" >>"$log"
		sh -c "$cmd" >>"$log" 2>&1 </dev/null || exit 123
	done
	: >"$out/${ENV_OUTPUT_FILE}"
	;;
*)
	exit 124
	;;
esac
`;

/** Tools each evaluation needs by name; the rest of VERIFIER_TOOLS are used when present. */
const SOURCE_TOOLS: Readonly<Record<EnvSourceKind, readonly string[]>> = {
	direnv: ["direnv", "bash"],
	mise: ["mise"],
	flake: ["nix"],
	devenv: ["devenv", "nix"],
};

/** Optional helpers: direnv's stdlib, mise and installers call these by name. */
const ENV_HELPERS = [
	"nix",
	"nix-shell",
	"mise",
	"mktemp",
	"realpath",
	"readlink",
	"which",
	"curl",
	"xz",
	"unzip",
	"node",
] as const;

export type EnvRunFailure =
	| "nix_trusted"
	| "sandbox_refused"
	| "probe_failed"
	| "timed_out"
	| "size_cap"
	| "failed"
	| "no_output";

export type EnvRunResult =
	| {
			ok: true;
			/** The step's export, raw and untrusted. */
			output: Buffer;
			log: string;
			/** Host-observed: what the proxy allowed and refused. */
			egress: EgressStats | null;
			/** The evaluation sandbox's own PATH entries. */
			sandboxPath: string[];
			/** Everything the sandbox was started with: its baseline. */
			sandboxEnv: Record<string, string>;
	  }
	| {
			ok: false;
			code: EnvRunFailure;
			reason: string;
			fix: string;
			log: string;
			egress: EgressStats | null;
	  };

export interface EnvRunRequest {
	step: EnvSourceKind | "setup";
	/** For `setup`: the commands, run in order. */
	commands?: readonly string[];
	/** For `setup`: let lifecycle scripts run (`env.trustedDependencies` is not empty). */
	lifecycleScripts?: boolean;
	projectRoot: string;
	stateDir: string;
	mfwHome: string;
	/** A full commit id the owner approved. */
	commit: string;
	allow: readonly (AllowEntry & { host: string; port: number })[];
	/** Host directory bound at /cache/env-data, read-write (an evaluation's). */
	dataDir?: string;
	/** The evaluated environment the step runs in (setup), with the root its data is bound from. */
	devEnv?: { grant: DevEnvGrant; bindRoot: string };
	timeoutMs: number;
	/** Before the launch: put the deps or anything else into the fresh tree. */
	prepareTree?: (tree: string) => Promise<void>;
	/** After a zero exit: take what the step produced out of the tree. */
	collectTree?: (tree: string) => Promise<void>;
	/** Extra binds of a captured environment (env-install). */
	profile?: (base: SandboxProfile) => SandboxProfile;
	maxTreeBytes?: number;
	maxDataBytes?: number;
	steps?: LauncherSteps;
	startProxy?: (
		configPath: string,
		socketPath: string,
	) => Promise<() => Promise<void>>;
	/** Whether the nix daemon trusts this user; asked on the host, before anything runs. */
	nixTrust?: () => Promise<"untrusted" | "trusted" | "unknown">;
	signal?: AbortSignal;
}

const LOG_TAIL_BYTES = 64 * 1024;
const DEFAULT_TREE_BYTES = 16 * 1024 ** 3;
const DEFAULT_DATA_BYTES = 16 * 1024 ** 3;
const OUTBOX_BYTES = 8 * 1024 * 1024;

/** Fixed, root-owned locations of the nix client. `PATH` is never consulted. */
const NIX_TOOLS = [
	"/run/current-system/sw/bin/nix",
	"/nix/var/nix/profiles/default/bin/nix",
] as const;

/**
 * Ask the daemon whether it trusts this user. Runs the host's own nix with an
 * empty environment and no project file anywhere near it.
 */
export async function hostNixTrust(): Promise<
	"untrusted" | "trusted" | "unknown"
> {
	for (const tool of NIX_TOOLS) {
		try {
			const child = Bun.spawn(
				[
					tool,
					"--extra-experimental-features",
					"nix-command",
					"store",
					"info",
					"--json",
				],
				{
					env: { NIX_REMOTE: "daemon" },
					cwd: "/",
					stdin: "ignore",
					stdout: "pipe",
					stderr: "ignore",
				},
			);
			const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
			const text = await new Response(child.stdout).text();
			const code = await child.exited;
			clearTimeout(timer);
			if (code !== 0) continue;
			const parsed = JSON.parse(text) as { trusted?: unknown };
			if (parsed.trusted === 0 || parsed.trusted === false) return "untrusted";
			if (parsed.trusted === 1 || parsed.trusted === true) return "trusted";
		} catch {}
	}
	return "unknown";
}

function fail(
	code: EnvRunFailure,
	reason: string,
	fix: string,
	log = "",
	egress: EgressStats | null = null,
): EnvRunResult {
	return { ok: false, code, reason, fix, log, egress };
}

async function readLog(outbox: string): Promise<string> {
	const r = await readRegularFile(
		join(outbox, ENV_LOG_FILE),
		LOG_TAIL_BYTES,
		0,
	);
	if (!r) return "";
	const tail =
		r.size > LOG_TAIL_BYTES
			? ((await readRegularFile(
					join(outbox, ENV_LOG_FILE),
					LOG_TAIL_BYTES,
					r.size - LOG_TAIL_BYTES,
				)) ?? r)
			: r;
	return tail.buffer.toString("utf8");
}

/** Run one env step in its sandbox. Never falls back to running anything on the host. */
export async function runEnvStep(req: EnvRunRequest): Promise<EnvRunResult> {
	const evaluate = req.step !== "setup";
	const nix = evaluate && req.step !== "mise";
	if (nix) {
		const trust = await (req.nixTrust ?? hostNixTrust)();
		if (trust !== "untrusted") {
			return fail(
				"nix_trusted",
				trust === "trusted"
					? "the nix daemon trusts this user, so code in the evaluation could add unsigned paths to the host's store or choose its own substituters"
					: "the nix daemon did not say whether it trusts this user",
				"remove this user from trusted-users in nix.conf (keep it in allowed-users), or set env.source to mise or none for this project",
			);
		}
	}
	const steps: LauncherSteps = req.steps ?? {
		...realLaunchSteps,
		compileHost: liveCompileHost,
	};
	const runId = `env-${randomUUID()}`;
	const mfwHome = realpathSync(req.mfwHome);
	const stateDir = realpathSync(req.stateDir);
	const projectRoot = realpathSync(req.projectRoot);
	mkdirSync(join(stateDir, "runs"), { recursive: true, mode: 0o700 });
	const runDir = join(stateDir, "runs", runId);
	ensureRunDirLayout(runDir);
	const layout = runDirLayout(runDir);
	let dataDir: string | undefined;
	if (req.dataDir) {
		mkdirSync(req.dataDir, { recursive: true, mode: 0o700 });
		dataDir = realpathSync(req.dataDir);
	}
	const clones = new VerifierClones({
		workspaceRoot: join(mfwHome, "workspaces"),
		primaryRoot: projectRoot,
	});
	const handle = await openProjectDb(stateDir);
	const live: {
		stop: (() => Promise<void>) | null;
		clone: Awaited<ReturnType<VerifierClones["create"]>> | null;
	} = { stop: null, clone: null };
	let statsPath = "";
	const body = async (): Promise<EnvRunResult> => {
		const clone = await clones.create(req.commit, `env-${req.step}`);
		live.clone = clone;
		await req.prepareTree?.(clone.path);
		const entry = join(runDir, RUN_CONTROL_DIR, ENV_ENTRY_FILE);
		writeFileSync(entry, ENV_ENTRY_SCRIPT, { mode: 0o444, flag: "wx" });
		chmodSync(entry, 0o444);

		const prepared = prepareRunEgress({
			mfwHome,
			runDir,
			runId,
			allow: [...req.allow],
		});
		statsPath = prepared.statsPath;
		live.stop = await (
			req.startProxy ??
			((c: string, s: string) => startRealProxy(c, s, "the env build's"))
		)(prepared.configPath, prepared.socketPath);

		const required = [
			"sh",
			"bun",
			...(evaluate ? SOURCE_TOOLS[req.step as EnvSourceKind] : []),
		];
		const candidates = [
			...new Set([
				...required,
				...AGENT_BASE_TOOLS,
				...VERIFIER_TOOLS,
				...ENV_HELPERS,
			]),
		];
		let host: CompileHost;
		let profile: SandboxProfile;
		try {
			const looked = await steps.compileHost(
				{ mfwHome, cli: "claude", stateDir } as never,
				candidates,
				[
					dirname(clone.path),
					runDir,
					dirname(prepared.socketDir),
					...(dataDir ? [dirname(dataDir)] : []),
					...(req.devEnv ? [req.devEnv.bindRoot] : []),
				],
			);
			const found = new Set(looked.toolchain.resolved.map((b) => b.name));
			const missing = required.filter((t) => !found.has(t));
			if (missing.length > 0) {
				return fail(
					"sandbox_refused",
					`the host has no ${missing.join(", ")} for the ${req.step} step`,
					`install ${missing.join(" and ")} on the host (on PATH), or set env.source for this project`,
				);
			}
			const binaries = candidates.filter((t) => found.has(t));
			host = {
				...looked,
				toolchain: {
					...looked.toolchain,
					resolved: looked.toolchain.resolved.filter((b) =>
						binaries.includes(b.name),
					),
				},
			};
			const base = buildEnvProfile({
				role: evaluate ? "env-build" : "env-install",
				tree: clone.path,
				runDir,
				binaries,
				egressSocketDir: prepared.socketDir,
				...(dataDir ? { dataDir } : {}),
				...(req.devEnv ? { devEnv: req.devEnv.grant } : {}),
				nixDaemon: nix,
			});
			profile = req.profile ? req.profile(base) : base;
		} catch (err) {
			if (
				err instanceof AgentProfileError ||
				err instanceof ProfileRejectedError
			) {
				return fail(
					"sandbox_refused",
					err.message,
					"this is a bug in mfw: report it",
				);
			}
			if ((err as Error).name === "SandboxUnavailableError") {
				return fail(
					"sandbox_refused",
					(err as Error).message,
					"run `mfw doctor`",
				);
			}
			throw err;
		}
		const tool = (name: string) =>
			host.toolchain.resolved.find((b) => b.name === name)?.path as string;
		const argv = withEgressRelay({ runDir }, tool("bun"), [
			tool("sh"),
			`/mfw-run/control/${ENV_ENTRY_FILE}`,
			req.step,
			...(req.step === "setup"
				? [req.lifecycleScripts === true ? "on" : "off"]
				: []),
			...(req.commands ?? []),
		]);
		const compiled = compileBwrap(profile, argv, host);
		if (!compiled.ok) {
			return fail(
				"sandbox_refused",
				`${compiled.code}: ${compiled.reason}`,
				compiled.fix,
			);
		}
		const parent = findWritableBindParent(compiled.pinnedBinds);
		if (parent) {
			return fail(
				"sandbox_refused",
				`${parent.parent.label} is writable and holds ${parent.child.label}`,
				"keep the env data directory apart from the clone",
			);
		}
		const attested = await steps.attest({
			db: handle.db,
			runId,
			profile,
			host,
			targets: {
				home: host.home,
				mfwHome: host.mfwHome,
				protectedPaths: protectedPaths({ projectRoot, stateDir }, host.home),
				fleetExecBaseline: [],
			},
		});
		if (!attested.ok)
			return fail("sandbox_refused", attested.reason, attested.fix);
		if (attested.outcome !== "pass") {
			const failed = attested.items
				.filter((i) => i.status !== "pass")
				.map((i) => `${i.id} (${i.detail.slice(0, 200)})`);
			return fail(
				"probe_failed",
				`the env-build sandbox probe failed: ${failed.join(", ").slice(0, 1000)}`,
				"run `mfw doctor`, fix the failing items, then retry",
			);
		}
		const gate = await steps.authorize(handle.db, {
			runId,
			approvalMode: "autonomous",
			profile,
			compiled,
			bwrapVersion: host.caps.bwrap.value.version ?? "unknown",
		});
		if (!gate.ok || gate.authorization === null) {
			return fail(
				"sandbox_refused",
				gate.ok ? "the gate granted no authorization" : gate.reason,
				gate.ok ? "retry" : gate.fix,
			);
		}

		const child = steps.launch(compiled, {
			approvalMode: "autonomous",
			authorization: gate.authorization,
		});
		(child.stdin as unknown as { end(): void }).end();
		let stopped: "timed_out" | "size_cap" | null = null;
		let capDetail = "";
		const kill = (why: "timed_out" | "size_cap", detail = "") => {
			if (!stopped) {
				stopped = why;
				capDetail = detail;
			}
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => kill("timed_out"), req.timeoutMs);
		const abort = () => kill("timed_out", "aborted");
		req.signal?.addEventListener("abort", abort, { once: true });
		const watchers = [
			watchTreeSize(clone.path, req.maxTreeBytes ?? DEFAULT_TREE_BYTES, (w) =>
				kill("size_cap", `the tree (${w})`),
			),
			...(dataDir
				? [
						watchTreeSize(
							dataDir,
							req.maxDataBytes ?? DEFAULT_DATA_BYTES,
							(w) => kill("size_cap", `the data directory (${w})`),
						),
					]
				: []),
			watchTreeSize(layout.outbox, OUTBOX_BYTES, (w) =>
				kill("size_cap", `the outbox (${w})`),
			),
		];
		let exitCode: number;
		try {
			const [, , code] = await Promise.all([
				drainTail(child.stdout as never, LOG_TAIL_BYTES),
				drainTail(child.stderr as never, LOG_TAIL_BYTES),
				child.exited,
			]);
			exitCode = code;
		} finally {
			clearTimeout(timer);
			req.signal?.removeEventListener("abort", abort);
			for (const stop of watchers) stop();
		}
		const log = await readLog(layout.outbox);
		if (stopped === "timed_out") {
			return fail(
				"timed_out",
				capDetail === "aborted"
					? "the env step was stopped"
					: `the ${req.step} step ran past its ${Math.round(req.timeoutMs / 1000)} s deadline`,
				"make the evaluation faster, or raise env.timeoutSeconds for this project",
				log,
			);
		}
		if (stopped === "size_cap") {
			return fail(
				"size_cap",
				`the ${req.step} step wrote too much to ${capDetail}`,
				"reduce what the environment downloads or builds into the tree",
				log,
			);
		}
		if (exitCode === 125) {
			return fail(
				"nix_trusted",
				"inside the sandbox the nix daemon trusts this user, or did not say",
				"remove this user from trusted-users in nix.conf",
				log,
			);
		}
		if (exitCode !== 0) {
			return fail(
				"failed",
				`the ${req.step} step exited ${exitCode}`,
				"read the log, fix the environment at a new commit, and allow that commit",
				log,
			);
		}
		const out = await readRegularFile(
			join(layout.outbox, ENV_OUTPUT_FILE),
			OUTBOX_BYTES,
			0,
		);
		if (!out) {
			return fail(
				"no_output",
				`the ${req.step} step wrote no export`,
				"read the log",
				log,
			);
		}
		await req.collectTree?.(clone.path);
		return {
			ok: true,
			output: out.buffer,
			log,
			egress: null,
			sandboxPath: (compiled.env.PATH ?? "").split(":").filter(Boolean),
			sandboxEnv: compiled.env,
		};
	};
	let result: EnvRunResult | null = null;
	let egress: EgressStats | null = null;
	try {
		result = await body();
	} finally {
		// Stop, wait, record, and only then delete: the counters are the
		// host-observed record of what project code reached.
		let recorded = live.stop === null;
		try {
			await live.stop?.();
			if (live.stop) {
				egress = parseEgressStats(readIfPresent(statsPath));
				await ingestRunEgress(handle.db, runId, runDir, new Date());
				recorded = true;
			}
		} catch {
			recorded = false;
		}
		handle.close();
		if (recorded) rmSync(runDir, { recursive: true, force: true });
		await live.clone?.dispose().catch(() => {});
	}
	return { ...result, egress };
}

function readIfPresent(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}
