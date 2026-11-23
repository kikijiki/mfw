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
 * That bun is the host's, inherited as sealed descriptors (probe-runtime.ts).
 * Nothing is mounted for it, so the probe attests the agent's exact mount table
 * and a profile needs no runtime of its own.
 *
 * {@link attestSandbox} is the only path that records an attestation, and it
 * takes no way to stub an observation or alter the compiled sandbox. The tests
 * compose the lower-level pieces in probe-collect.ts instead.
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
	FIRST_PINNED_FD,
	SANDBOX_PATHS,
} from "./compile-bwrap.ts";
import type { PinIdentity } from "./pinned-binds.ts";
import {
	type ProbeSpec,
	type ProbeSyscall,
	probeChildSource,
} from "./probe-child.ts";
import { collectProbe } from "./probe-collect.ts";
import {
	type ProbeExpectation,
	type ProbeItemResult,
	probeOutcome,
} from "./probe-evaluate.ts";
import {
	ProbeRuntimeError,
	type SealedProbeRuntime,
	sealProbeRuntime,
} from "./probe-runtime.ts";
import {
	effectiveLimits,
	memoryBytes,
	parseSandboxProfile,
	type SandboxProfile,
} from "./profile.ts";
import {
	ALLOWED_SOCKET_FAMILIES,
	DENIED_ARG_MASKS,
	DENIED_SYSCALLS,
	EAFNOSUPPORT,
	ENOSYS,
	ENOSYS_SYSCALLS,
	EPERM,
	PROBED_DENIED_FAMILIES,
} from "./seccomp.ts";
import type { ToolchainPlan } from "./toolchain.ts";

/** The socket's name inside a turn's directory (brain-socket.ts). */
export const BRAIN_SOCKET_NAME = "brain.sock";

const CLONE_THREAD = 0x10000;
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

/** Families the filter must refuse, and the allowed ones as the control. */
export function socketFamilyPlan(): { family: number; expect: number }[] {
	const EINVAL = 22;
	return [
		...PROBED_DENIED_FAMILIES.map((family) => ({
			family,
			expect: EAFNOSUPPORT,
		})),
		...Object.values(ALLOWED_SOCKET_FAMILIES).map((family) => ({
			family,
			expect: EINVAL,
		})),
	];
}

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
	opts: {
		nonce: string;
		loopbackPort: number;
		scope: "systemd" | "none";
		/** The child descriptors of the sealed runtime. */
		sealedFds?: readonly number[];
	},
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
			socketFamilies: socketFamilyPlan().map((s) => s.family),
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
			socketFamilies: socketFamilyPlan(),
			seccompFilters: hostSeccompFilters() + 1,
			scope: opts.scope,
			limits: {
				tasksMax: limits.tasksMax,
				memoryMaxBytes: memoryBytes(limits.memoryMax),
			},
			sweepTolerated: targets.toolchainBinds.map(escapedPath),
			fleetExecBaseline: targets.fleetExecBaseline,
			...(opts.sealedFds ? { sealedFds: opts.sealedFds } : {}),
			...(profile.filesystem?.brainSocket
				? { brainSocket: `${SANDBOX_PATHS.brain}/${BRAIN_SOCKET_NAME}` }
				: {}),
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
	/** The directories the probe really ran against. */
	pins: PinIdentity[];
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
	tmpDir?: string;
}

/** Bun's arguments for the probe: no config, `.env` or cwd from the sandbox. */
const probeBunArgs = (): string[] => [
	"--cwd=/",
	"--config=/dev/null",
	"--no-env-file",
	"-e",
	probeChildSource(),
];

/** The probe command for a bun already inside the sandbox (lower-level tests). */
export function probeCommand(bunPath: string): string[] {
	return [bunPath, ...probeBunArgs()];
}

export interface SealedProbeCommand {
	compiled: CompiledSandbox;
	/** The child descriptors of the runtime, right after the pinned binds. */
	sealedFds: number[];
}

/** Compile the profile around the sealed runtime's command. */
export function compileSealedProbe(
	profile: SandboxProfile,
	host: CompileHost,
	runtime: Pick<SealedProbeRuntime, "fds" | "command">,
): SealedProbeCommand | CompileRefusal {
	// The pins depend on the profile alone, so this fixes the descriptor numbers.
	const shape = compileBwrap(profile, ["/proc/self/exe"], host);
	if (!shape.ok) return shape;
	const first = FIRST_PINNED_FD + shape.pinnedBinds.length;
	const compiled = compileBwrap(
		profile,
		runtime.command(first, probeBunArgs()),
		host,
	);
	if (!compiled.ok) return compiled;
	return { compiled, sealedFds: runtime.fds.map((_, i) => first + i) };
}

/**
 * Compile the profile, probe it, and record the outcome. A failed probe is
 * still recorded, because a newer failure must revoke an older pass.
 */
export async function attestSandbox(
	req: AttestRequest,
): Promise<AttestResult | AttestRefusal> {
	const profile = parseSandboxProfile(req.profile);
	let runtime: SealedProbeRuntime;
	try {
		runtime = sealProbeRuntime();
	} catch (err) {
		if (!(err instanceof ProbeRuntimeError)) throw err;
		return {
			ok: false,
			code: "probe_runtime_missing",
			reason: `the probe's sealed runtime is unavailable: ${err.message}`,
			fix: "run on glibc 2.30 or newer with vm.memfd_noexec at 0 or 1",
		};
	}
	let compiled: CompiledSandbox;
	const scope = req.scope ?? "systemd";
	let pins: PinIdentity[] = [];
	let items: ProbeItemResult[];
	try {
		const sealed = compileSealedProbe(profile, req.host, runtime);
		if ("ok" in sealed) return compileRefused(sealed);
		compiled = sealed.compiled;
		const launched = compiled;
		items = await withLoopbackCanary((loopbackPort) =>
			collectProbe(
				launched,
				buildProbePlan(
					profile,
					launched,
					{
						...req.targets,
						...probeToolchainTargets(req.host.toolchain),
						realpath: req.host.realpath,
					},
					{
						nonce: randomBytes(16).toString("hex"),
						loopbackPort,
						scope,
						sealedFds: sealed.sealedFds,
					},
				),
				{
					scope,
					timeoutMs: req.timeoutMs,
					tmpDir: req.tmpDir,
					sealed: runtime,
					observePins: (seen) => {
						pins = seen;
					},
				},
			),
		);
	} finally {
		runtime.close();
	}
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
		createdAt: new Date(),
	});
	return { ok: true, attestationId, outcome, items, fingerprint, pins };
}

function compileRefused(r: CompileRefusal): AttestRefusal {
	return {
		ok: false,
		code: "compile_refused",
		reason: `${r.code}: ${r.reason}`,
		fix: r.fix,
	};
}
