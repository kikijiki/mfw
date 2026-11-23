/**
 * The SandboxProfile of every role other than task and repair (design "Role
 * profiles"). Each builder states what its role gets; the schema's per-role
 * ceilings (profile.ts) refuse anything beyond that, so a builder bug is a
 * refusal rather than a wider sandbox.
 *
 * | role                | workspace        | host paths it can write     | network |
 * |---------------------|------------------|-----------------------------|---------|
 * | verifier, merge     | disposable clone | that tree (gitdir is ro)    | none    |
 * | reviewer, plan,     | read-only        | outbox, private CLI state   | proxy   |
 * | import              |                  |                             |         |
 * | brain               | read-only        | outbox, private CLI state   | proxy + |
 * |                     |                  |                             | socket  |
 * | trigger             | read-only        | outbox, private CLI state   | proxy   |
 *
 * `trigger` is the agent of an `action` run. A trigger's `script` action is the
 * owner's armed host command and does not run here.
 */

import {
	AGENT_BASE_TOOLS,
	cloneLayout,
	type FleetCli,
	fleetPrivateState,
	TEMPORARY_FLEET_WRITABLE,
} from "./agent-profile.ts";
import { parseSandboxProfile, type SandboxProfile } from "./profile.ts";

/** The roles an agent CLI runs in with a read-only workspace. */
export const READ_ONLY_AGENT_ROLES = [
	"reviewer",
	"plan",
	"import",
	"brain",
	"trigger",
] as const;

export type VerifyRole = "verifier" | "merge-verify";
export type ReadOnlyAgentRole = (typeof READ_ONLY_AGENT_ROLES)[number];

export function isReadOnlyAgentRole(role: string): role is ReadOnlyAgentRole {
	return (READ_ONLY_AGENT_ROLES as readonly string[]).includes(role);
}

/** Limits of one check: enough for a test suite, bounded against a fork bomb. */
export const VERIFIER_LIMITS = { tasksMax: 2048, memoryMax: "8G" } as const;

/** Limits of a read-only agent, which runs a CLI and its read-only tools. */
export const READ_ONLY_AGENT_LIMITS = {
	tasksMax: 1024,
	memoryMax: "4G",
} as const;

/**
 * What a check may call by name, when the host has it. Until P8 brings the
 * project's dev shell into the sandbox, this is the check's whole toolchain.
 */
export const VERIFIER_TOOLS = [
	...AGENT_BASE_TOOLS,
	"bun",
	"bunx",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"git",
	"make",
	"just",
	"cargo",
	"rustc",
	"go",
	"python3",
	"cc",
	"gcc",
	"ld",
	"as",
	"ar",
	"true",
	"false",
	"test",
	"expr",
	"seq",
	"stat",
	"du",
	"printf",
	"id",
	"uname",
	"tar",
	"gzip",
] as const;

const SANDBOX_PROCESS = {
	userns: "disabled",
	seccomp: "denylist",
	terminal: "none",
} as const;

const LIFECYCLE = { dieWithParent: true, newSession: true } as const;

export interface VerifierProfileInput {
	role: VerifyRole;
	/** The disposable clone's work tree. */
	tree: string;
	binaries: readonly string[];
	env?: Record<string, string>;
}

/** A check: the clone's tree writable, its gitdir read-only, nothing else. */
export function buildVerifierProfile(
	input: VerifierProfileInput,
): SandboxProfile {
	const clone = cloneLayout(input.tree);
	return parseSandboxProfile({
		version: 1,
		role: input.role,
		home: "synthetic",
		filesystem: {
			workspace: {
				source: clone.tree,
				gitDir: clone.gitDir,
				access: "rw",
				gitAccess: "ro",
			},
			scratch: "tmpfs",
			toolchain: { binaries: [...new Set(input.binaries)] },
		},
		process: { ...SANDBOX_PROCESS, env: input.env ?? {} },
		network: { mode: "none" },
		resources: VERIFIER_LIMITS,
		lifecycle: LIFECYCLE,
	});
}

export interface ReadOnlyAgentInput {
	role: ReadOnlyAgentRole;
	tree: string;
	runDir: string;
	cli: FleetCli;
	fleetDir: string;
	binaries: readonly string[];
	env: Record<string, string>;
	/** The run's own proxy socket directory. Absent means no network at all. */
	egressSocketDir?: string;
	/** Brain role: the directory holding this turn's socket and token. */
	brainSocketDir?: string;
	/** Where the CLI's private session state lives, when it outlives the clone. */
	fleetState?: string;
}

/** An agent that reads the project and reports through its outbox. */
export function buildReadOnlyAgentProfile(
	input: ReadOnlyAgentInput,
): SandboxProfile {
	const clone = cloneLayout(input.tree);
	return parseSandboxProfile({
		version: 1,
		role: input.role,
		home: "synthetic",
		filesystem: {
			workspace: { source: clone.tree, gitDir: clone.gitDir, access: "ro" },
			runDir: { source: input.runDir, outbox: "rw" },
			scratch: "tmpfs",
			toolchain: { binaries: [...new Set(input.binaries)] },
			fleetConfig: {
				cli: input.cli,
				source: input.fleetDir,
				writable: [...TEMPORARY_FLEET_WRITABLE[input.cli]],
				privateState:
					input.fleetState ?? fleetPrivateState(clone.tree, input.cli),
			},
			...(input.brainSocketDir
				? { brainSocket: { source: input.brainSocketDir } }
				: {}),
		},
		process: { ...SANDBOX_PROCESS, env: input.env },
		network: input.egressSocketDir
			? { mode: "proxy", socketDir: input.egressSocketDir }
			: { mode: "none" },
		resources: READ_ONLY_AGENT_LIMITS,
		lifecycle: LIFECYCLE,
	});
}
