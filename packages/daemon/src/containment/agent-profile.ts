/**
 * The SandboxProfile of a task or repair run, and the checks on what a launch
 * is about to expose (design "Bridge on the host", "Agent config").
 *
 * Other roles are P7. There is no `$HOME` bind: the agent gets the synthetic
 * home, its clone, the run's control and outbox, and its fleet config dir.
 * Egress exists only when the caller hands in a proxy socket directory.
 */

import { lstatSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PinnedBind } from "./pinned-binds.ts";
import { parseSandboxProfile, type SandboxProfile } from "./profile.ts";

/** Printed wherever the temporary fleet allowlist below is in force. */
export const UNATTESTED_CONFIG_MARKER = "unattested-config";

/**
 * TEMPORARY, until P4 supplies the versioned per-CLI allowlist. These are the
 * provisional directories from the sandbox experiments and are not attested
 * for an authenticated CLI. Files in the config root (`.claude.json`,
 * `auth.json`, Codex's sqlite state) stay read-only, so a CLI that must rewrite
 * them fails rather than gaining a writable config root. `plugins/store` is
 * left out because a CLI loads code from it.
 *
 * Each run mounts a private, empty copy of these directories over the shared
 * ones (see {@link fleetPrivateState}): a CLI loads instructions and scripts
 * from them, so what one run writes must never reach another. Task and repair
 * runs start fresh sessions, so nothing is imported.
 */
export const TEMPORARY_FLEET_WRITABLE = {
	claude: ["backups", "projects", "sessions"],
	codex: ["cache", "sessions", "shell_snapshots", "thread-writer-locks", "tmp"],
} as const;

export type FleetCli = keyof typeof TEMPORARY_FLEET_WRITABLE;

/**
 * Ordinary tools an agent's shell commands expect. PATH is built only from
 * declared binaries, and on NixOS each lives in its own store directory, so an
 * undeclared `rm` or `cat` is not found by name. Used when present.
 *
 * This is a convenience and not a boundary: on NixOS all of `/nix/store` is
 * bound, so an undeclared binary still runs by its absolute path (toolchain.ts).
 */
export const AGENT_BASE_TOOLS = [
	"awk",
	"basename",
	"bash",
	"cat",
	"chmod",
	"cp",
	"cut",
	"date",
	"diff",
	"dirname",
	"env",
	"find",
	"grep",
	"head",
	"ln",
	"ls",
	"mkdir",
	"mktemp",
	"mv",
	"node",
	"readlink",
	"realpath",
	"rg",
	"rm",
	"rmdir",
	"sed",
	"sh",
	"sleep",
	"sort",
	"tail",
	"tee",
	"touch",
	"tr",
	"uniq",
	"wc",
	"xargs",
] as const;

/** What to look up on the host: the required binaries, then the base tools. */
export function agentToolCandidates(required: readonly string[]): string[] {
	return [...new Set([...required, ...AGENT_BASE_TOOLS])];
}

/**
 * The binaries to declare: every required one (a missing one is then refused
 * by the compiler) and the base tools this host actually has.
 */
export function declaredAgentBinaries(
	required: readonly string[],
	found: readonly { name: string }[],
): string[] {
	const have = new Set(found.map((b) => b.name));
	return [
		...new Set([
			...required,
			...AGENT_BASE_TOOLS.filter((tool) => have.has(tool)),
		]),
	];
}

/** Limits of a task or repair run. */
const RUN_LIMITS = { tasksMax: 4096, memoryMax: "8G" } as const;

export type AgentProfileCode = "workspace_not_clone";

export class AgentProfileError extends Error {
	readonly code: AgentProfileCode;
	readonly fix: string;
	constructor(code: AgentProfileCode, message: string, fix: string) {
		super(message);
		this.name = "AgentProfileError";
		this.code = code;
		this.fix = fix;
	}
}

export interface CloneLayout {
	root: string;
	tree: string;
	gitDir: string;
}

const CLONE_FIX =
	'set "runWorkspace": "clone" for this project: a sandboxed run needs a private clone';

function isRealDir(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function isRealFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * The clone around a work tree: `<root>/{tree,git,mfw-workspace.json}`. A linked
 * worktree is refused, because its gitdir lives in the primary repository.
 */
export function cloneLayout(tree: string): CloneLayout {
	const root = dirname(tree);
	const gitDir = join(root, "git");
	if (
		basename(tree) !== "tree" ||
		!isRealDir(tree) ||
		!isRealDir(gitDir) ||
		!isRealFile(join(root, "mfw-workspace.json"))
	) {
		throw new AgentProfileError(
			"workspace_not_clone",
			`${tree} is not a private run clone`,
			CLONE_FIX,
		);
	}
	return { root, tree, gitDir };
}

/** This run's private fleet state: beside its clone, never bound as a whole. */
export function fleetPrivateState(tree: string, cli: FleetCli): string {
	return join(dirname(tree), "fleet-state", cli);
}

/** Create the private directories, and the mount points they need. */
export function ensureFleetPrivateState(
	tree: string,
	cli: FleetCli,
	fleetDir: string,
): void {
	const state = fleetPrivateState(tree, cli);
	for (const rel of TEMPORARY_FLEET_WRITABLE[cli]) {
		mkdirSync(join(state, rel), { recursive: true, mode: 0o700 });
		if (isRealDir(fleetDir)) {
			mkdirSync(join(fleetDir, rel), { recursive: true, mode: 0o700 });
		}
	}
}

export interface RunProfileInput {
	role: "task" | "repair";
	tree: string;
	runDir: string;
	cli: FleetCli;
	fleetDir: string;
	/** Everything the sandbox must be able to execute, including `bun` for the probe. */
	binaries: readonly string[];
	env: Record<string, string>;
	/** The run's own proxy socket directory. Absent means no network at all. */
	egressSocketDir?: string;
	deny?: readonly string[];
	/** The end-of-run snapshot: the clone and run dir only, no fleet config. */
	snapshotOnly?: boolean;
}

export function buildRunProfile(input: RunProfileInput): SandboxProfile {
	const clone = cloneLayout(input.tree);
	return parseSandboxProfile({
		version: 1,
		role: input.role,
		home: "synthetic",
		filesystem: {
			workspace: { source: clone.tree, gitDir: clone.gitDir, access: "rw" },
			runDir: { source: input.runDir, outbox: "rw" },
			scratch: "tmpfs",
			toolchain: { binaries: [...new Set(input.binaries)] },
			...(input.snapshotOnly
				? {}
				: {
						fleetConfig: {
							cli: input.cli,
							source: input.fleetDir,
							writable: [...TEMPORARY_FLEET_WRITABLE[input.cli]],
							privateState: fleetPrivateState(clone.tree, input.cli),
						},
					}),
			...(input.deny?.length ? { deny: [...input.deny] } : {}),
		},
		process: {
			env: input.env,
			userns: "disabled",
			seccomp: "denylist",
			terminal: "none",
		},
		network: input.egressSocketDir
			? { mode: "proxy", socketDir: input.egressSocketDir }
			: { mode: "none" },
		resources: RUN_LIMITS,
		lifecycle: { dieWithParent: true, newSession: true },
	});
}

const inside = (path: string, dir: string) => path.startsWith(`${dir}/`);

/**
 * A writable bind that holds another bind's source, or null. Whoever can write
 * a source's parent can rename the source and swap what a later launch mounts.
 */
export function findWritableBindParent(
	binds: readonly PinnedBind[],
): { parent: PinnedBind; child: PinnedBind } | null {
	for (const parent of binds) {
		if (!parent.writable) continue;
		const child = binds.find((b) => inside(b.source, parent.source));
		if (child) return { parent, child };
	}
	return null;
}

/** Credential shapes that must never travel in a command line or public env. */
const TOKEN_SHAPES = [
	/\bsk-[A-Za-z0-9_-]{16,}/,
	/\bgh[pousr]_[A-Za-z0-9]{20,}/,
	/\bgithub_pat_[A-Za-z0-9_]{20,}/,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/-----BEGIN [A-Z ]*PRIVATE\sKEY-----/,
];

export interface LaunchSecretCheck {
	argv: readonly string[];
	env: Readonly<Record<string, string>>;
	/** Values of the run's granted secrets. */
	secretValues: readonly string[];
	/** The real home, `$MFW_HOME` and other host paths, in every spelling. */
	forbiddenPaths: readonly string[];
	/** The resolved agent binary, which may live in a home toolchain root. */
	allowedArgv0?: string;
}

function mentionsPath(value: string, path: string): boolean {
	let at = value.indexOf(path);
	while (at >= 0) {
		const next = value[at + path.length];
		if (next === undefined || !/[A-Za-z0-9._-]/.test(next)) return true;
		at = value.indexOf(path, at + 1);
	}
	return false;
}

/**
 * Where a secret or a protected host path appears in the agent's argv or
 * public env, or null. The answer names the place and never the value.
 */
export function findLaunchSecret(check: LaunchSecretCheck): string | null {
	const leak = (value: string): string | null => {
		if (check.secretValues.some((s) => s !== "" && value.includes(s))) {
			return "a granted secret";
		}
		if (TOKEN_SHAPES.some((shape) => shape.test(value))) {
			return "a credential-shaped value";
		}
		return check.forbiddenPaths.some((p) => mentionsPath(value, p))
			? "a protected host path"
			: null;
	};
	for (const [i, arg] of check.argv.entries()) {
		if (i === 0 && arg === check.allowedArgv0) continue;
		const what = leak(arg);
		if (what) return `argv[${i}] holds ${what}`;
	}
	for (const [name, value] of Object.entries(check.env)) {
		const what = leak(value);
		if (what) return `env ${name} holds ${what}`;
	}
	return null;
}

/** Flags that make a CLI act without asking. Only an authorized launch may carry them. */
const AUTONOMY_FLAGS = [
	"--dangerously-skip-permissions",
	"--allow-dangerously-skip-permissions",
	"--dangerously-bypass-approvals-and-sandbox",
	"--full-auto",
	"--yolo",
];

/** Options that grant autonomy only with one of these values. */
const AUTONOMY_VALUES: Readonly<Record<string, string>> = {
	"--permission-mode": "bypassPermissions",
	"--ask-for-approval": "never",
	"-a": "never",
	"--sandbox": "danger-full-access",
	"-s": "danger-full-access",
};

/** Codex `-c key=value` overrides that do the same. */
const AUTONOMY_CONFIG: Readonly<Record<string, string>> = {
	approval_policy: "never",
	sandbox_mode: "danger-full-access",
};

const CONFIG_OPTIONS = ["-c", "--config"];

const unquoted = (value: string) => value.trim().replace(/^["']|["']$/g, "");

function isAutonomyConfig(setting: string): boolean {
	const at = setting.indexOf("=");
	if (at < 0) return false;
	const wanted = AUTONOMY_CONFIG[setting.slice(0, at).trim()];
	return wanted !== undefined && unquoted(setting.slice(at + 1)) === wanted;
}

/** How many arguments at `i` grant autonomy: 0, 1, or 2 for an option and value. */
function autonomySpan(argv: readonly string[], i: number): number {
	const arg = argv[i] as string;
	if (AUTONOMY_FLAGS.some((f) => arg === f || arg.startsWith(`${f}=`)))
		return 1;
	const next = argv[i + 1];
	if (AUTONOMY_VALUES[arg] !== undefined) {
		return next !== undefined && unquoted(next) === AUTONOMY_VALUES[arg]
			? 2
			: 0;
	}
	if (CONFIG_OPTIONS.includes(arg)) {
		return next !== undefined && isAutonomyConfig(next) ? 2 : 0;
	}
	const eq = arg.indexOf("=");
	if (eq < 0) return 0;
	const name = arg.slice(0, eq);
	const value = arg.slice(eq + 1);
	if (AUTONOMY_VALUES[name] !== undefined) {
		return unquoted(value) === AUTONOMY_VALUES[name] ? 1 : 0;
	}
	return CONFIG_OPTIONS.includes(name) && isAutonomyConfig(value) ? 1 : 0;
}

export function autonomyFlags(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; ) {
		const span = autonomySpan(argv, i);
		if (span > 0) out.push(argv.slice(i, i + span).join(" "));
		i += span || 1;
	}
	return out;
}

export function withoutAutonomyFlags(argv: readonly string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; ) {
		const span = autonomySpan(argv, i);
		if (span === 0) out.push(argv[i] as string);
		i += span || 1;
	}
	return out;
}
