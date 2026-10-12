import { filesOutsideOwns, ownsPath } from "@mfw/board-core";
import { PROJECT_DEFAULTS } from "./config.ts";
import { runProc } from "./proc.ts";

/**
 * Diff-scope watchdog. While a local run works, the supervisor samples what
 * its worktree changed against the run's base and compares it with the task's
 * `owns` and with the `owns` of every other claimed task:
 *
 *   files    every path changed since `baseSha` (committed, staged, unstaged
 *            and untracked, ignored files excluded)
 *   outside  changed paths the run's own `owns` does not cover
 *   foreign  outside paths that another claimed task owns
 *
 * Touching another live task's files, or more than `maxFiles` files, is a kill
 * (`watchdog-scope`, `watchdog-files`). Outside-own-only paths are common and
 * benign mid-run (a new helper next to the owned code), so they are only shown
 * live and enforced at finish (`onFinish: review`).
 *
 * Sampling is read-only (`GIT_OPTIONAL_LOCKS=0`, no index refresh write) and
 * runs in a worktree the agent is writing: any git failure yields no sample,
 * and no sample never kills.
 */

export type ScopeMode = "off" | "warn" | "kill";

export interface ScopePolicy {
	/** off: no sampling; warn: sample and show; kill: sample and enforce. */
	mode: ScopeMode;
	/** More changed files than this is a `watchdog-files` kill. */
	maxFiles: number;
	/** Minimum gap between two samples of one run. */
	sampleMs: number;
	/** A file owned by another claimed task: kill (`watchdog-scope`) or only show. */
	foreignOwned: "warn" | "kill";
	/** At finish, files outside the task's own `owns` send it to review. */
	onFinish: "off" | "review";
}

export const DEFAULT_SCOPE_POLICY: ScopePolicy = {
	...PROJECT_DEFAULTS.watchdog.scope,
};

/** The kill reasons the scope watchdog fires. */
export const SCOPE_KILL_REASONS = ["watchdog-scope", "watchdog-files"] as const;
export type ScopeKillReason = (typeof SCOPE_KILL_REASONS)[number];

export function isScopeKillReason(
	reason: string | null | undefined,
): reason is ScopeKillReason {
	return (SCOPE_KILL_REASONS as readonly string[]).includes(reason ?? "");
}

export type ScopeLevel = "ok" | "warn" | "violation";

/** Paths listed on the run row; counts are always exact. */
const LISTED = 20;

/** What `runs.scope_sample` holds (the UI reads the counts). */
export interface ScopeSample {
	files: number;
	outside: number;
	foreign: number;
	level: ScopeLevel;
	maxFiles: number;
	sampledAt: number;
	/** First paths outside the task's `owns`, for the brief and the UI. */
	outsideFiles: string[];
	/** First paths another claimed task owns, with that task. */
	foreignFiles: { path: string; taskId: string }[];
	/** The changed-file listing hit its output cap: `files` is a lower bound. */
	truncated?: boolean;
}

export interface ScopeOwners {
	/** The run's own task `owns` (empty = no scope declared). */
	owns: readonly string[];
	/** Every other claimed task and its `owns`. */
	others: readonly { taskId: string; owns: readonly string[] }[];
}

/**
 * The claimed tasks whose `owns` count as foreign to `run`. The sibling rule:
 * a claim held by the run's own attempt group is never foreign, so competing
 * attempts of one task (and a continuation of the same worktree chain) cannot
 * kill each other over the files their shared task owns.
 */
export function foreignClaims(
	run: { id: string; groupId?: string | null },
	claimed: readonly {
		id: string;
		claimedByGroupId: string | null;
		owns: readonly string[];
	}[],
): { taskId: string; owns: readonly string[] }[] {
	const mine = run.groupId ?? run.id;
	return claimed
		.filter(
			(t) =>
				t.claimedByGroupId !== null &&
				t.claimedByGroupId !== mine &&
				t.owns.length > 0,
		)
		.map((t) => ({ taskId: t.id, owns: t.owns }));
}

/** Paths that are mfw's own bookkeeping inside a worktree, never agent scope. */
function isBookkeeping(path: string): boolean {
	return path === "MFW_REPORT.json" || path.startsWith(".mfw/");
}

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_OUTPUT = 1024 * 1024;

async function gitList(
	args: string[],
	cwd: string,
): Promise<{ paths: string[]; truncated: boolean }> {
	const r = await runProc(["git", ...args], {
		cwd,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
		timeoutMs: GIT_TIMEOUT_MS,
		maxOutputBytes: GIT_MAX_OUTPUT,
	});
	if (r.exitCode !== 0) {
		throw new Error(
			`git ${args[0]} failed (${r.exitCode ?? r.signalCode}): ${r.stderr.trim()}`,
		);
	}
	const parts = r.stdout.split("\0").filter(Boolean);
	// A tail-kept, truncated listing starts mid-path: drop the partial head.
	if (r.truncated) parts.shift();
	return { paths: parts, truncated: r.truncated };
}

/**
 * Every path the worktree changed since `baseSha`: tracked differences
 * (committed or not) plus untracked, non-ignored files. Throws on any git
 * failure; the caller treats that as "no sample".
 */
export async function changedFiles(
	worktreePath: string,
	baseSha: string,
): Promise<{ files: string[]; truncated: boolean }> {
	const tracked = await gitList(
		["diff", "--name-only", "--no-renames", "-z", baseSha, "--"],
		worktreePath,
	);
	const untracked = await gitList(
		["ls-files", "--others", "--exclude-standard", "-z"],
		worktreePath,
	);
	const files = [
		...new Set([...tracked.paths, ...untracked.paths].filter(Boolean)),
	]
		.filter((p) => !isBookkeeping(p))
		.sort();
	return { files, truncated: tracked.truncated || untracked.truncated };
}

/** Classify a changed-file set against the run's and other tasks' `owns`. */
export function assessScope(
	files: readonly string[],
	owners: ScopeOwners,
	policy: Pick<ScopePolicy, "maxFiles">,
	sampledAt: number,
	truncated = false,
): ScopeSample {
	const outside = filesOutsideOwns(owners.owns, files);
	// A file the run's own `owns` covers is never foreign, even if another
	// task's `owns` overlaps it (the scheduler already holds overlapping tasks).
	const ownCovered = (p: string) => owners.owns.some((o) => ownsPath(o, p));
	const foreign: { path: string; taskId: string }[] = [];
	for (const path of files) {
		if (ownCovered(path)) continue;
		const owner = owners.others.find((t) =>
			t.owns.some((o) => ownsPath(o, path)),
		);
		if (owner) foreign.push({ path, taskId: owner.taskId });
	}
	const level: ScopeLevel =
		files.length > policy.maxFiles || foreign.length > 0
			? "violation"
			: outside.length > 0
				? "warn"
				: "ok";
	return {
		files: files.length,
		outside: outside.length,
		foreign: foreign.length,
		level,
		maxFiles: policy.maxFiles,
		sampledAt,
		outsideFiles: outside.slice(0, LISTED),
		foreignFiles: foreign.slice(0, LISTED),
		...(truncated ? { truncated: true } : {}),
	};
}

/** The kill a sample calls for under `policy`, or null. */
export function scopeKill(
	sample: ScopeSample,
	policy: ScopePolicy,
): ScopeKillReason | null {
	if (policy.mode !== "kill") return null;
	if (sample.foreign > 0 && policy.foreignOwned === "kill")
		return "watchdog-scope";
	if (sample.files > policy.maxFiles) return "watchdog-files";
	return null;
}

/** Counts identity: a sample is persisted only when this changes. */
export function scopeSignature(sample: ScopeSample): string {
	return `${sample.level}:${sample.files}:${sample.outside}:${sample.foreign}`;
}

/** Read `runs.scope_sample` back defensively (it is JSON from an older daemon too). */
export function asScopeSample(raw: unknown): ScopeSample | null {
	if (typeof raw !== "object" || raw === null) return null;
	const o = raw as Partial<ScopeSample>;
	if (typeof o.files !== "number") return null;
	return {
		files: o.files,
		outside: typeof o.outside === "number" ? o.outside : 0,
		foreign: typeof o.foreign === "number" ? o.foreign : 0,
		level:
			o.level === "warn" || o.level === "violation" || o.level === "ok"
				? o.level
				: "ok",
		maxFiles: typeof o.maxFiles === "number" ? o.maxFiles : 0,
		sampledAt: typeof o.sampledAt === "number" ? o.sampledAt : 0,
		outsideFiles: Array.isArray(o.outsideFiles)
			? o.outsideFiles.filter((p): p is string => typeof p === "string")
			: [],
		foreignFiles: Array.isArray(o.foreignFiles)
			? o.foreignFiles.filter(
					(f): f is { path: string; taskId: string } =>
						typeof f?.path === "string" && typeof f?.taskId === "string",
				)
			: [],
		...(o.truncated ? { truncated: true } : {}),
	};
}
