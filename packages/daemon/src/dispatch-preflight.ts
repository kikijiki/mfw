import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.ts";
import { type RefusalFix, refusalFix } from "./refusal-fix.ts";

/**
 * Refuse a local dispatch early, before anything is claimed or leased, when
 * it is certain to fail or to hurt the host, and say exactly what to do. Each
 * check is a known way a start used to fail late with a raw git error (or not
 * fail and take the machine down).
 */

export type PreflightCode =
	| "integration_branch_missing"
	| "branch_exists"
	| "worktree_exists"
	| "memory_floor"
	/** The task's route is rate-limit held (`provider-holds.ts`); waitingFor = [hold key]. */
	| "provider_held"
	/** A resource budget the task depends on is exhausted (`budgets.ts`); waitingFor = [budget key]. */
	| "budget_exhausted";

export class DispatchPreflightError extends Error {
	readonly fix: RefusalFix;
	constructor(
		readonly code: PreflightCode,
		/** What the refusal is about (branch, path, or the memory figures). */
		readonly waitingFor: string[],
		message: string,
	) {
		super(message);
		this.name = "DispatchPreflightError";
		this.fix = refusalFix(code, waitingFor);
	}
}

export interface DispatchPreflightDeps {
	projectRoot: string;
	integrationBranch: string;
	/** Refuse while the host has less available memory than this. 0/absent = off. */
	memoryFloorBytes?: bigint;
	/** Current `MemAvailable`; null when unknown (the check then passes). */
	memAvailableBytes?: () => Promise<bigint | null>;
}

const MiB = 1024n * 1024n;

export async function preflightDispatch(
	deps: DispatchPreflightDeps,
	runId: string,
): Promise<void> {
	const root = deps.projectRoot;
	const integration = deps.integrationBranch;
	const base = await git(
		["rev-parse", "--verify", "-q", `refs/heads/${integration}^{commit}`],
		root,
	);
	if (base.exitCode !== 0) {
		throw new DispatchPreflightError(
			"integration_branch_missing",
			[integration],
			`integration branch '${integration}' does not exist`,
		);
	}
	const branch = `mfw/${runId}`;
	const existing = await git(
		["rev-parse", "--verify", "-q", `refs/heads/${branch}`],
		root,
	);
	if (existing.exitCode === 0) {
		throw new DispatchPreflightError(
			"branch_exists",
			[branch],
			`run branch '${branch}' already exists`,
		);
	}
	const path = join(root, "worktrees", runId);
	if (
		await access(path).then(
			() => true,
			() => false,
		)
	) {
		throw new DispatchPreflightError(
			"worktree_exists",
			[path],
			`run worktree path '${path}' already exists`,
		);
	}
	const floor = deps.memoryFloorBytes ?? 0n;
	if (floor > 0n && deps.memAvailableBytes) {
		const available = await deps.memAvailableBytes().catch(() => null);
		if (available !== null && available < floor) {
			throw new DispatchPreflightError(
				"memory_floor",
				[`${available / MiB} MiB available`, `${floor / MiB} MiB floor`],
				`host memory is below the dispatch floor: ${available / MiB} MiB available, floor ${floor / MiB} MiB`,
			);
		}
	}
}

/** `MemAvailable` from /proc/meminfo, or null where there is none (non-Linux). */
export async function readMemAvailable(): Promise<bigint | null> {
	const text = await readFile("/proc/meminfo", "utf8").catch(() => null);
	const match = text ? /^MemAvailable:\s+(\d+)\s+kB$/m.exec(text) : null;
	return match?.[1] ? BigInt(match[1]) * 1024n : null;
}
