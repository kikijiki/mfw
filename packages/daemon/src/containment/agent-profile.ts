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
import { UNATTESTED_CONFIG_MARKER } from "@mfw/plugin-api/harness";
import {
	findAutonomyFlags,
	stripAutonomyFlags,
} from "@mfw/plugin-api/harness-autonomy";
import { builtinHarnessRegistry } from "@mfw/plugin-api/harness-registry";
import type { PinnedBind } from "./pinned-binds.ts";
import { parseSandboxProfile, type SandboxProfile } from "./profile.ts";

/** Printed wherever the temporary fleet allowlist below is in force. */
export { UNATTESTED_CONFIG_MARKER };

/** The fleet dirs the sandbox profile knows (`profile.ts` holds the same closed list). */
export type FleetCli = "claude" | "codex";

const fleetWritable = (cli: FleetCli): readonly string[] =>
	builtinHarnessRegistry().byFleetCli(cli).fleet.writable;

/**
 * TEMPORARY, until P4 supplies the versioned per-CLI allowlist: the manifests
 * carry the provisional directories, marked `unattested-config`.
 *
 * Each run mounts a private, empty copy of these directories over the shared
 * ones (see {@link fleetPrivateState}): a CLI loads instructions and scripts
 * from them, so what one run writes must never reach another. Task and repair
 * runs start fresh sessions, so nothing is imported.
 */
export const TEMPORARY_FLEET_WRITABLE: Readonly<
	Record<FleetCli, readonly string[]>
> = {
	claude: fleetWritable("claude"),
	codex: fleetWritable("codex"),
};

/**
 * Ordinary tools an agent's shell commands expect. PATH is built only from
 * declared binaries, and on NixOS each lives in its own store directory, so an
 * undeclared `rm` or `cat` is not found by name. Used when present.
 *
 * On NixOS the sandbox holds only the closure of the declared binaries, with
 * the executables of undeclared members hidden (toolchain.ts). This is not a
 * boundary against a determined agent: `bun` and `node` are declared and run
 * any code, and on FHS hosts `/usr` is bound whole. The network namespace and
 * the egress proxy are what limit where that code can connect.
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
	state: string = fleetPrivateState(tree, cli),
): void {
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

/**
 * The arguments that make a CLI act without asking: the core's known list plus
 * every manifest's. Only an authorized launch may carry them.
 */
export function autonomyFlags(argv: readonly string[]): string[] {
	return findAutonomyFlags(builtinHarnessRegistry().autonomy, argv);
}

export function withoutAutonomyFlags(argv: readonly string[]): string[] {
	return stripAutonomyFlags(builtinHarnessRegistry().autonomy, argv);
}
