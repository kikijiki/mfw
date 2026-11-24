import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.ts";
import { type RefusalFix, refusalFix } from "./refusal-fix.ts";
import { workspaceRootOf } from "./run-workspace/factory.ts";

/**
 * Refuse a local dispatch early, before anything is claimed or leased, when
 * it is certain to fail or to hurt the host, and say exactly what to do. Each
 * check is a known way a start used to fail late with a raw git error (or not
 * fail and take the machine down).
 */

export type PreflightCode =
	| "integration_branch_missing"
	| "workspace_exists"
	| "memory_floor"
	/** The task's route is rate-limit held (`provider-holds.ts`); waitingFor = [hold key]. */
	| "provider_held"
	/** A resource budget the task depends on is exhausted (`budgets.ts`); waitingFor = [budget key]. */
	| "budget_exhausted"
	/** Autonomous approval without a usable bwrap sandbox (missing, or isolation is `none`). */
	| "sandbox_unavailable"
	/** The sandbox exists but the minimal probe failed (`containment/minimal-probe.ts`). */
	| "sandbox_probe_failed"
	/** Autonomy on a target whose sandbox is not attested; waitingFor = [target kind]. */
	| "remote_autonomy_unsupported"
	/** This run kind has no sandbox profile yet, so it cannot run autonomously. */
	| "sandbox_role_unavailable";

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
	/**
	 * Autonomy needs isolation: returns the refusal (code and what is wrong)
	 * when the run would be autonomous without a bwrap sandbox that passes the
	 * minimal probe, null when it may go. Absent = no sandbox gate.
	 */
	sandbox?: () => Promise<{
		code: "sandbox_unavailable" | "sandbox_probe_failed";
		detail: string;
	} | null>;
}

const MiB = 1024n * 1024n;

/**
 * The targets whose sandbox mfw can attest. Only `local` is: it has the bwrap
 * gate above. Any other target, including one added later, is refused until
 * it is listed here.
 */
const ATTESTED_TARGET_KINDS: ReadonlySet<string> = new Set(["local"]);

/**
 * Refuses an autonomous run on a target with no attested sandbox, before
 * anything is claimed or leased. The check at remote launch stays as a backstop.
 */
export function preflightRemoteAutonomy(
	targetKind: string,
	approvalMode: "autonomous" | "interactive",
): void {
	if (approvalMode !== "autonomous" || ATTESTED_TARGET_KINDS.has(targetKind)) {
		return;
	}
	throw new DispatchPreflightError(
		"remote_autonomy_unsupported",
		[targetKind],
		`execution target '${targetKind}' cannot run autonomously: it has no attested sandbox`,
	);
}

export async function preflightDispatch(
	deps: DispatchPreflightDeps,
	runId: string,
): Promise<void> {
	const refused = await deps.sandbox?.();
	if (refused) {
		throw new DispatchPreflightError(
			refused.code,
			[refused.detail],
			`autonomous runs need a working sandbox: ${refused.detail}`,
		);
	}
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
	const workspaces = workspaceRootOf(root);
	const path = workspaces ? join(workspaces, runId) : null;
	if (
		path &&
		(await access(path).then(
			() => true,
			() => false,
		))
	) {
		throw new DispatchPreflightError(
			"workspace_exists",
			[path],
			`run workspace '${path}' already exists`,
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
