/**
 * Run the probe inside a compiled sandbox and turn what the host saw into an
 * attestation (design "Probe barrier").
 *
 * The only input trusted from the sandbox is the child's stdout pipe, held by
 * this process through the launcher. No file is read back. The stream must be
 * exactly the ready line and one result line carrying a nonce generated for
 * this launch, and the child must exit 0. Anything else, including a timeout
 * or oversized output, is recorded as a failure of every item.
 *
 * The probe starts bun with `--cwd=/ --config=/dev/null --no-env-file`. Without
 * them bun loads `bunfig.toml` and `.env` from the sandbox's working directory,
 * which is the agent-writable workspace, and a planted preload would run inside
 * the probe and could forge its result.
 *
 * A profile whose toolchain does not declare `bun` cannot be probed and is
 * refused: adding a runtime only for the probe would attest a different
 * sandbox from the one the agent gets.
 *
 * Cgroup limits are read from the host, while the child is alive, because the
 * sandbox has no `/sys`. That path needs a real user manager and is not
 * exercised by the caged test suite.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import net from "node:net";
import type { ProjectDb } from "@mfw/db/client";
import { recordAttestation } from "./attestation-store.ts";
import {
	type CompiledSandbox,
	type CompileHost,
	type CompileRefusal,
	compileBwrap,
	SANDBOX_PATHS,
} from "./compile-bwrap.ts";
import { launchSandbox } from "./launch-sandbox.ts";
import type { PinIdentity } from "./pinned-binds.ts";
import {
	PROBE_READY,
	PROBE_RESULT,
	type ProbeSpec,
	type ProbeSyscall,
	probeChildSource,
} from "./probe-child.ts";
import {
	type CgroupObservation,
	evaluateProbe,
	failAll,
	type ProbeExpectation,
	type ProbeItemResult,
	ProbeObservationsSchema,
	probeOutcome,
} from "./probe-evaluate.ts";
import {
	effectiveLimits,
	memoryBytes,
	parseSandboxProfile,
	type SandboxProfile,
} from "./profile.ts";
import {
	DENIED_ARG_MASKS,
	DENIED_SYSCALLS,
	ENOSYS,
	ENOSYS_SYSCALLS,
	EPERM,
} from "./seccomp.ts";
import type { ToolchainPlan } from "./toolchain.ts";

const CLONE_THREAD = 0x10000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const SWEEP_MAX_ENTRIES = 1_000_000;
const SWEEP_DEADLINE_MS = 25_000;

/** Env names whose values are credentials: redacted from hashes, checked in pid 1. */
const isSecretEnv = (name: string): boolean =>
	name.startsWith("MFW_GRANT_") || name.endsWith("_API_KEY");

/**
 * Arguments that make an unfiltered call fail harmlessly. `-1` is a bad
 * descriptor. `ptrace` must not get 0, which is `PTRACE_TRACEME`.
 */
const FD_ARG0 = new Set([
	"io_uring_enter",
	"io_uring_register",
	"pidfd_getfd",
	"setns",
	"move_mount",
	"open_tree",
	"fsconfig",
	"fsmount",
	"fspick",
	"mount_setattr",
	"open_by_handle_at",
	"name_to_handle_at",
	"kexec_file_load",
	"finit_module",
	"ptrace",
]);

/**
 * Denied syscalls whose expected errno proves nothing alone. Without a filter
 * the first eleven still return it to an unprivileged caller; `bpf` and
 * `io_uring_setup` do on hosts that disable them by sysctl.
 */
const NOT_PROVABLE_SYSCALLS: ReadonlySet<string> = new Set([
	"userfaultfd",
	"move_mount",
	"fsopen",
	"fsmount",
	"fspick",
	"kexec_load",
	"kexec_file_load",
	"init_module",
	"finit_module",
	"delete_module",
	"fanotify_init",
	"bpf",
	"io_uring_setup",
]);

/** Every syscall the filter must deny, with the errno it must produce. */
export function probeSyscallPlan(): ProbeSyscall[] {
	const plain = Object.entries(DENIED_SYSCALLS).map(([name, nr]) => ({
		name,
		nr,
		arg0: FD_ARG0.has(name) ? -1 : 0,
		expect: EPERM,
		provable: !NOT_PROVABLE_SYSCALLS.has(name),
	}));
	const enosys = Object.entries(ENOSYS_SYSCALLS).map(([name, nr]) => ({
		name,
		nr,
		arg0: 0,
		expect: ENOSYS,
		provable: true,
	}));
	// CLONE_THREAD without CLONE_SIGHAND is EINVAL, so nothing is created
	// if the filter is missing.
	const masked = Object.entries(DENIED_ARG_MASKS).map(([name, m]) => ({
		name,
		nr: m.nr,
		arg0: m.mask | CLONE_THREAD,
		expect: EPERM,
		provable: true,
	}));
	return [...plain, ...enosys, ...masked];
}

/** The bwrap options, one per entry. */
export function decodeBwrapOptions(bytes: Buffer): string[] {
	const text = bytes.toString();
	return text.endsWith("\0") ? text.slice(0, -1).split("\0") : [];
}

const sha256 = (data: string | Buffer): string =>
	createHash("sha256").update(data).digest("hex");

/** JSON with sorted keys, so equal values hash equally. */
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		const o = value as Record<string, unknown>;
		const body = Object.keys(o)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`);
		return `{${body.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export interface SandboxFingerprint {
	profileHash: string;
	optionsHash: string;
	seccompHash: string;
}

/**
 * What ties an attestation to a launch. The command is left out, because the
 * probe and the agent run different commands in the same sandbox. The `env` and
 * bwrap paths and the fixed argv up to the command are in. Bind sources are
 * included, since `--bind-fd` options carry only a descriptor number.
 * Credential values are redacted, so a low-entropy secret cannot be guessed
 * from a stored hash.
 */
export function sandboxFingerprint(
	profile: SandboxProfile,
	compiled: CompiledSandbox,
): SandboxFingerprint {
	const redactedProfile = structuredClone(profile);
	const env = redactedProfile.process?.env;
	if (env) {
		for (const name of Object.keys(env)) {
			if (isSecretEnv(name)) env[name] = "(redacted)";
		}
	}
	const options = decodeBwrapOptions(compiled.bwrapArgs);
	const redacted: string[] = [];
	for (let i = 0; i < options.length; i++) {
		const o = options[i] as string;
		redacted.push(o);
		if (o !== "--setenv") continue;
		const name = options[i + 1] as string;
		redacted.push(
			name,
			isSecretEnv(name) ? "(redacted)" : (options[i + 2] as string),
		);
		i += 2;
	}
	const split = compiled.argv.indexOf("--");
	const scope = compiled.argv
		.slice(0, split)
		.filter((a) => !a.startsWith("--unit="));
	// `env -i <bwrap> --args 4 --`: which binaries enforce all of the above.
	const launcher = compiled.argv.slice(split + 1, split + 7);
	return {
		profileHash: sha256(canonical(redactedProfile)),
		optionsHash: sha256(
			canonical({
				options: redacted,
				pins: compiled.pinnedBinds,
				scope,
				launcher,
			}),
		),
		seccompHash: sha256(compiled.seccomp),
	};
}

/** The writable mounts this compiled sandbox must show, and no others. */
export function expectedWritableMounts(compiled: CompiledSandbox): string[] {
	const options = decodeBwrapOptions(compiled.bwrapArgs);
	const out = new Set([
		"/proc",
		"/dev",
		"/dev/null",
		"/dev/zero",
		"/dev/full",
		"/dev/random",
		"/dev/urandom",
		"/dev/tty",
		"/dev/pts",
		"/tmp",
		"/run/user",
		SANDBOX_PATHS.home,
	]);
	if (options.includes(SANDBOX_PATHS.scratch)) out.add(SANDBOX_PATHS.scratch);
	for (const pin of compiled.pinnedBinds) {
		if (pin.writable) out.add(pin.dest);
	}
	return [...out];
}

export interface ProbeTargets {
	/** The real home and `$MFW_HOME`. */
	home: string;
	mfwHome: string;
	/** The primary repo, the owner's agent config, and any other protected path. */
	protectedPaths: readonly string[];
	/**
	 * Toolchain roots allowed to recreate part of the real home. These come from
	 * the toolchain plan and never from the compiled options, or a compiler bug
	 * that bound `~/.ssh` would approve itself.
	 */
	toolchainHomeRoots: readonly string[];
	/** Every toolchain and system bind: the only place an unlistable directory is tolerated. */
	toolchainBinds: readonly string[];
	/**
	 * Executables already known in writable fleet directories, by sandbox path
	 * and sha256. Anything else there fails `exec_sweep`.
	 */
	fleetExecBaseline: readonly { path: string; sha256: string }[];
	/** Resolves symlinks; null when the path does not exist on the host. */
	realpath(path: string): string | null;
}

/** A path as configured and as resolved: a bind may use either. */
function pathForms(path: string, targets: ProbeTargets): string[] {
	const real = targets.realpath(path);
	return real && real !== path ? [path, real] : [path];
}

/** Every form of the home, each with the toolchain roots seen through it. */
function homeForms(targets: ProbeTargets): ProbeSpec["homes"] {
	const roots = targets.toolchainHomeRoots.filter((r) =>
		r.startsWith(`${targets.home}/`),
	);
	return pathForms(targets.home, targets).map((path) => ({
		path,
		allowedRoots: [
			...new Set(
				roots.flatMap((r) => [
					`${path}${r.slice(targets.home.length)}`,
					...pathForms(r, targets).filter((f) => f.startsWith(`${path}/`)),
				]),
			),
		],
	}));
}

/** The same selection the compiler mounts for a profile that declares binaries. */
export function probeToolchainTargets(
	plan: ToolchainPlan,
): Pick<ProbeTargets, "toolchainHomeRoots" | "toolchainBinds"> {
	const mounted = plan.binds.filter(
		(b) => !(b.source === "home" && b.optional),
	);
	return {
		toolchainHomeRoots: mounted
			.filter((b) => b.source === "home")
			.map((b) => b.path),
		toolchainBinds: mounted.map((b) => b.path),
	};
}

/** The child's escaped form of a path, so the two can be compared. */
function escapedPath(path: string): string {
	let out = "";
	for (const c of Buffer.from(path)) {
		if (c === 0x5c) out += "\\\\";
		else if (c >= 0x20 && c < 0x7f) out += String.fromCharCode(c);
		else out += `\\x${c.toString(16).padStart(2, "0")}`;
	}
	return out;
}

export interface ProbePlan {
	spec: ProbeSpec;
	expectation: ProbeExpectation;
}

/** What to tell the child and what to hold its answer to. */
export function buildProbePlan(
	profile: SandboxProfile,
	compiled: CompiledSandbox,
	targets: ProbeTargets,
	opts: { nonce: string; loopbackPort: number; scope: "systemd" | "none" },
): ProbePlan {
	const options = decodeBwrapOptions(compiled.bwrapArgs);
	const syscalls = probeSyscallPlan();
	const hookDirs: string[] = [];
	const gitDirs: string[] = [];
	if (profile.filesystem?.workspace) {
		hookDirs.push(`${SANDBOX_PATHS.workspace}/.git/hooks`);
		gitDirs.push(`${SANDBOX_PATHS.workspace}/.git`);
		if (profile.filesystem.workspace.gitDir) {
			hookDirs.push(`${SANDBOX_PATHS.gitDir}/hooks`);
			gitDirs.push(SANDBOX_PATHS.gitDir);
		}
	}
	const limits = effectiveLimits(profile);
	const secrets = Object.entries(profile.process?.env ?? {})
		.filter(([name]) => isSecretEnv(name))
		.map(([name, value]) => ({ name, value }));
	return {
		spec: {
			nonce: opts.nonce,
			loopbackPort: opts.loopbackPort,
			absentPaths: [
				...new Set(
					[targets.mfwHome, ...targets.protectedPaths].flatMap((p) =>
						pathForms(p, targets),
					),
				),
			],
			homes: homeForms(targets),
			hookDirs,
			gitConfigs: gitDirs.flatMap((d) => [
				`${d}/config`,
				`${d}/config.worktree`,
			]),
			fleetWritable: compiled.pinnedBinds
				.filter(
					(p) => p.writable && p.dest.startsWith(`${SANDBOX_PATHS.fleet}/`),
				)
				.map((p) => p.dest),
			egressDir: SANDBOX_PATHS.egress,
			syscalls,
			// `/sys` holds no sockets and is its own failing item if it is mounted at all.
			sweepSkip: ["/proc", "/dev", "/sys", "/nix/store"],
			maxEntries: SWEEP_MAX_ENTRIES,
			deadlineMs: SWEEP_DEADLINE_MS,
		},
		expectation: {
			nonce: opts.nonce,
			options,
			writableMounts: expectedWritableMounts(compiled),
			egress: profile.network?.mode === "proxy" ? "proxy" : "none",
			egressDir: SANDBOX_PATHS.egress,
			// bwrap sets PWD itself when it changes directory.
			envNames: [...Object.keys(compiled.env), "PWD"],
			secrets,
			syscalls: syscalls.map((s) => ({
				name: s.name,
				expect: s.expect,
				provable: s.provable,
			})),
			seccompFilters: hostSeccompFilters() + 1,
			scope: opts.scope,
			limits: {
				tasksMax: limits.tasksMax,
				memoryMaxBytes: memoryBytes(limits.memoryMax),
			},
			sweepTolerated: targets.toolchainBinds.map(escapedPath),
			fleetExecBaseline: targets.fleetExecBaseline,
		},
	};
}

/** This process's filter count, which every child inherits; -2 if unreadable. */
function hostSeccompFilters(): number {
	try {
		const status = readFileSync("/proc/self/status", "utf8");
		const m = /^Seccomp_filters:\s*(\d+)$/m.exec(status);
		return m ? Number(m[1]) : -2;
	} catch {
		return -2;
	}
}

/** The scope's limits, read from the host's cgroup tree. */
export function readHostCgroup(pid: number): CgroupObservation | null {
	try {
		const line = readFileSync(`/proc/${pid}/cgroup`, "utf8").trim();
		if (!line.startsWith("0::/")) return null;
		const path = line.slice(3);
		const read = (name: string) => {
			try {
				return readFileSync(`/sys/fs/cgroup${path}/${name}`, "utf8").trim();
			} catch {
				return null;
			}
		};
		return {
			path,
			memoryMax: read("memory.max"),
			pidsMax: read("pids.max"),
			swapMax: read("memory.swap.max"),
		};
	} catch {
		return null;
	}
}

export interface CollectOptions {
	scope: "systemd" | "none";
	timeoutMs?: number;
	readCgroup?: (pid: number) => CgroupObservation | null;
	tmpDir?: string;
	observePins?: (pins: PinIdentity[]) => void;
}

/** Launch, speak the protocol, and judge. Never throws for a bad child. */
export async function collectProbe(
	compiled: CompiledSandbox,
	plan: ProbePlan,
	opts: CollectOptions,
): Promise<ProbeItemResult[]> {
	let child: ReturnType<typeof launchSandbox>;
	try {
		child = launchSandbox(compiled, {
			// The probe is host code. It grants nothing, and it is what an
			// autonomous launch needs first.
			approvalMode: "interactive",
			scope: opts.scope,
			tmpDir: opts.tmpDir,
			observePins: opts.observePins,
		});
	} catch (err) {
		return failAll(`the probe did not launch: ${(err as Error).message}`);
	}
	const stdin = child.stdin as unknown as {
		write(s: string): unknown;
		end(): unknown;
	};
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, timeoutMs);
	// Kept drained so a chatty child cannot block on a full pipe.
	const stderr = new Response(
		child.stderr as unknown as ReadableStream,
	).arrayBuffer();

	let cgroup: CgroupObservation | null = null;
	let text = "";
	let oversized = false;
	let answered = false;
	const decoder = new TextDecoder();
	try {
		for await (const chunk of child.stdout as unknown as AsyncIterable<Uint8Array>) {
			text += decoder.decode(chunk, { stream: true });
			if (text.length > MAX_OUTPUT) {
				oversized = true;
				child.kill("SIGKILL");
				break;
			}
			if (!answered && text.includes("\n")) {
				answered = true;
				if (text.startsWith(`${PROBE_READY}\n`)) {
					cgroup = (opts.readCgroup ?? readHostCgroup)(child.pid);
					stdin.write(JSON.stringify(plan.spec));
				}
				stdin.end();
			}
		}
		if (!answered) stdin.end();
	} catch {
		child.kill("SIGKILL");
	}
	const code = await child.exited;
	clearTimeout(timer);
	await stderr.catch(() => undefined);

	if (timedOut) return failAll(`the probe timed out after ${timeoutMs} ms`);
	if (oversized) return failAll("the probe's output exceeded the limit");
	if (code !== 0) return failAll(`the probe exited with ${code}`);
	const lines = text.split("\n");
	if (
		lines.length !== 3 ||
		lines[0] !== PROBE_READY ||
		lines[2] !== "" ||
		!lines[1]?.startsWith(`${PROBE_RESULT} `)
	) {
		return failAll("the probe's output is not one ready and one result line");
	}
	let json: unknown;
	try {
		json = JSON.parse((lines[1] as string).slice(PROBE_RESULT.length + 1));
	} catch {
		return failAll("the probe's result is not JSON");
	}
	const parsed = ProbeObservationsSchema.safeParse(json);
	if (!parsed.success) return failAll("the probe's result has the wrong shape");
	return evaluateProbe(parsed.data, plan.expectation, cgroup);
}

/** A closed-off loopback port: listening, so a shared network would reach it. */
async function withLoopbackCanary<T>(
	fn: (port: number) => Promise<T>,
): Promise<T> {
	const server = net.createServer((s) => s.destroy());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		return await fn((server.address() as net.AddressInfo).port);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

export type AttestRefusalCode = "probe_runtime_missing" | "compile_refused";

export interface AttestRefusal {
	ok: false;
	code: AttestRefusalCode;
	reason: string;
	fix: string;
}

export interface AttestResult {
	ok: true;
	attestationId: string;
	outcome: "pass" | "fail";
	items: ProbeItemResult[];
	fingerprint: SandboxFingerprint;
}

export interface AttestRequest {
	db: ProjectDb;
	runId: string;
	profile: SandboxProfile;
	host: CompileHost;
	targets: Omit<
		ProbeTargets,
		"toolchainHomeRoots" | "toolchainBinds" | "realpath"
	>;
	/** `none` is for tests and always fails `cgroup_limits`. */
	scope?: "systemd" | "none";
	timeoutMs?: number;
	readCgroup?: CollectOptions["readCgroup"];
	tmpDir?: string;
	now?: () => Date;
	/** Test seam: change the compiled sandbox to prove the probe notices. */
	weaken?: (compiled: CompiledSandbox) => CompiledSandbox;
}

/** The command that runs the probe with the sandbox's own bun. */
export function probeCommand(bunPath: string): string[] {
	return [
		bunPath,
		"--cwd=/",
		"--config=/dev/null",
		"--no-env-file",
		"-e",
		probeChildSource(),
	];
}

/**
 * Compile the profile, probe it, and record the outcome. A failed probe is
 * still recorded, because a newer failure must revoke an older pass.
 */
export async function attestSandbox(
	req: AttestRequest,
): Promise<AttestResult | AttestRefusal> {
	const profile = parseSandboxProfile(req.profile);
	const declared = profile.filesystem?.toolchain?.binaries ?? [];
	const bun = req.host.toolchain.resolved.find((b) => b.name === "bun");
	if (!bun || !declared.includes("bun")) {
		return {
			ok: false,
			code: "probe_runtime_missing",
			reason:
				"the profile's toolchain does not declare bun, which runs the probe",
			fix: 'add "bun" to filesystem.toolchain.binaries',
		};
	}
	const result = compileBwrap(profile, probeCommand(bun.path), req.host);
	if (!result.ok) return compileRefused(result);
	const compiled = req.weaken ? req.weaken(result) : result;
	const scope = req.scope ?? "systemd";
	let pins: PinIdentity[] = [];
	const items = await withLoopbackCanary((loopbackPort) =>
		collectProbe(
			compiled,
			buildProbePlan(
				profile,
				compiled,
				{
					...req.targets,
					...probeToolchainTargets(req.host.toolchain),
					realpath: req.host.realpath,
				},
				{
					nonce: randomBytes(16).toString("hex"),
					loopbackPort,
					scope,
				},
			),
			{
				scope,
				timeoutMs: req.timeoutMs,
				readCgroup: req.readCgroup,
				tmpDir: req.tmpDir,
				observePins: (seen) => {
					pins = seen;
				},
			},
		),
	);
	const outcome = probeOutcome(items);
	// Of what actually ran, so a changed sandbox can never inherit this record.
	const fingerprint = sandboxFingerprint(profile, compiled);
	const attestationId = await recordAttestation(req.db, {
		runId: req.runId,
		...fingerprint,
		bwrapVersion: req.host.caps.bwrap.value.version ?? "unknown",
		scope,
		outcome,
		items,
		pins,
		createdAt: (req.now ?? (() => new Date()))(),
	});
	return { ok: true, attestationId, outcome, items, fingerprint };
}

function compileRefused(r: CompileRefusal): AttestRefusal {
	return {
		ok: false,
		code: "compile_refused",
		reason: `${r.code}: ${r.reason}`,
		fix: r.fix,
	};
}
