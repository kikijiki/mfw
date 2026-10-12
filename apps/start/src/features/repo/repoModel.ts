/**
 * The repository view's pure half: what a URL means, how a branch is labelled,
 * and where each commit sits in the graph. No React and no DOM, so the rules
 * are tests rather than screens.
 */

export interface RepoSearch {
	/** Files: browse this branch/tag/commit instead of a checkout. */
	ref?: string;
	/** Files: a run's worktree. */
	run?: string;
	path?: string;
	file?: string;
	/** Branches and commits: free-text filter. */
	q?: string;
	/** Branches: which kind chip is on. */
	kind?: string;
	mode?: "two-dot";
	/** Commit, compare, worktree: the file open in the diff list. */
	f?: string;
}

export type RepoSection =
	| "files"
	| "branches"
	| "worktrees"
	| "commits"
	| "compare";

export type RepoView =
	| { section: "files" }
	| { section: "branches"; branch: null }
	| { section: "branches"; branch: string }
	| { section: "worktrees"; worktree: null }
	| { section: "worktrees"; worktree: string }
	| { section: "commits"; sha: null }
	| { section: "commits"; sha: string }
	| { section: "compare"; a: string | null; b: string | null };

function decode(segments: string[]): string {
	return segments
		.map((s) => {
			try {
				return decodeURIComponent(s);
			} catch {
				return s;
			}
		})
		.join("/");
}

/**
 * The splat after `/repo/`. Unknown shapes fall back to the Files section, so
 * a hand-edited URL lands somewhere useful instead of a not-found.
 */
export function parseRepoPath(splat: string): RepoView {
	const segments = splat.split("/").filter((s) => s.length > 0);
	const [head, ...rest] = segments;
	switch (head) {
		case "branches":
			return rest.length === 0
				? { section: "branches", branch: null }
				: { section: "branches", branch: decode(rest) };
		case "worktrees":
			return { section: "worktrees", worktree: null };
		case "worktree":
			return rest.length === 0
				? { section: "worktrees", worktree: null }
				: { section: "worktrees", worktree: decode(rest) };
		case "commits":
			return { section: "commits", sha: null };
		case "commit":
			return rest.length === 0
				? { section: "commits", sha: null }
				: { section: "commits", sha: decode(rest) };
		case "compare": {
			const joined = decode(rest);
			const cut = joined.indexOf("...");
			if (cut < 0) return { section: "compare", a: null, b: null };
			const a = joined.slice(0, cut);
			const b = joined.slice(cut + 3);
			return {
				section: "compare",
				a: a || null,
				b: b || null,
			};
		}
		default:
			return { section: "files" };
	}
}

export const SECTIONS: { id: RepoSection; label: string }[] = [
	{ id: "files", label: "Files" },
	{ id: "branches", label: "Branches" },
	{ id: "worktrees", label: "Worktrees" },
	{ id: "commits", label: "Commits" },
	{ id: "compare", label: "Compare" },
];

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

/** `mfw/01JABCDEFGHJKMNPQRSTVWXYZ0` is not a name anyone can read; keep the head. */
export function shortRef(name: string): string {
	const run = /^(mfw\/)([0-9A-HJKMNP-TV-Z]{26})$/.exec(name);
	if (run)
		return `${run[1]}${(run[2] as string).slice(0, 6)}…${(run[2] as string).slice(-4)}`;
	const wip = /^(wip\/(?:.+-)?)([0-9A-HJKMNP-TV-Z]{26})(-\d+)?$/.exec(name);
	if (wip)
		return `${wip[1]}${(wip[2] as string).slice(0, 6)}…${(wip[2] as string).slice(-4)}${wip[3] ?? ""}`;
	return name;
}

export function shortSha(sha: string): string {
	return sha.slice(0, 8);
}

export interface RefChipInput {
	name: string;
	kind: "head" | "local" | "remote" | "tag";
}

export interface RefChip {
	key: string;
	label: string;
	kind: RefChipInput["kind"];
	tone: "accent" | "ok" | "info" | "neutral" | "warn";
	/** The full name, for the title. */
	title: string;
	/** A branch (or tag) the UI can open; `HEAD` is not one. */
	linkable: boolean;
}

const KIND_ORDER: Record<RefChipInput["kind"], number> = {
	head: 0,
	local: 1,
	remote: 2,
	tag: 3,
};

/**
 * Decorations on a commit, in the order a reader scans them: HEAD, local
 * branches (the integration branch first), remotes, tags. A remote that points
 * at the same commit as a local branch of that name is folded into it
 * (`main` and `origin/main` read as one), because the pair is noise.
 */
export function refChips(
	refs: readonly RefChipInput[],
	integrationBranch: string,
): RefChip[] {
	const locals = new Set(
		refs.filter((r) => r.kind === "local").map((r) => r.name),
	);
	const out: RefChip[] = [];
	for (const ref of refs) {
		if (ref.kind === "remote") {
			const slash = ref.name.indexOf("/");
			const bare = slash >= 0 ? ref.name.slice(slash + 1) : ref.name;
			if (locals.has(bare)) continue;
		}
		out.push({
			key: `${ref.kind}:${ref.name}`,
			label: shortRef(ref.name),
			kind: ref.kind,
			title: ref.name,
			tone:
				ref.kind === "head"
					? "accent"
					: ref.kind === "tag"
						? "warn"
						: ref.kind === "remote"
							? "neutral"
							: ref.name === integrationBranch
								? "ok"
								: "info",
			linkable: ref.kind !== "head",
		});
	}
	const rank = (c: RefChip) =>
		KIND_ORDER[c.kind] * 2 + (c.title === integrationBranch ? 0 : 1);
	return out.sort((a, b) => rank(a) - rank(b));
}

// ---------------------------------------------------------------------------
// branches
// ---------------------------------------------------------------------------

/** A branch nobody has touched for this long, and that never landed, is stale. */
export const STALE_AFTER_DAYS = 30;

export interface BranchLike {
	name: string;
	kind: "local" | "remote";
	isIntegration: boolean;
	isHead: boolean;
	ahead: number;
	behind: number;
	merged: boolean;
	lastCommit: { author: string; time: number; subject: string };
	mfw: "run" | "wip" | null;
	run: { taskId: string | null; live: boolean; state: string } | null;
	mergeJob: { state: string } | null;
}

export function isStale(
	branch: Pick<BranchLike, "merged" | "isIntegration" | "lastCommit">,
	nowMs: number,
	days = STALE_AFTER_DAYS,
): boolean {
	if (branch.isIntegration || branch.merged) return false;
	const ageMs = nowMs - branch.lastCommit.time * 1000;
	return ageMs > days * 86_400_000;
}

export interface Badge {
	key: string;
	label: string;
	tone: "accent" | "ok" | "info" | "neutral" | "warn" | "critical";
	title?: string;
}

/**
 * Everything worth saying about a branch in a row, most important first.
 * "merged" only means something once the branch has left the base: a branch
 * that sits exactly on the integration tip is "at base", not "merged".
 */
export function branchBadges(branch: BranchLike, nowMs: number): Badge[] {
	const out: Badge[] = [];
	if (branch.isIntegration) {
		out.push({ key: "integration", label: "integration", tone: "ok" });
	}
	if (branch.isHead) {
		out.push({ key: "head", label: "checked out", tone: "accent" });
	}
	if (!branch.isIntegration) {
		if (branch.ahead === 0 && branch.behind === 0) {
			out.push({
				key: "base",
				label: "at base",
				tone: "neutral",
				title: "Points at the integration branch tip; nothing to merge.",
			});
		} else if (branch.merged) {
			out.push({
				key: "merged",
				label: "merged",
				tone: "ok",
				title: "Every commit on this branch is on the integration branch.",
			});
		}
	}
	if (isStale(branch, nowMs)) {
		out.push({
			key: "stale",
			label: "stale",
			tone: "warn",
			title: `No commit for more than ${STALE_AFTER_DAYS} days and not merged.`,
		});
	}
	if (branch.mfw === "run") {
		out.push({ key: "mfw", label: "mfw run", tone: "info" });
	}
	if (branch.mfw === "wip") {
		out.push({
			key: "wip",
			label: "wip archive",
			tone: "neutral",
			title: "Work saved from a run's worktree before it was cleaned up.",
		});
	}
	if (branch.mergeJob && branch.mergeJob.state !== "merged") {
		out.push({
			key: "merge",
			label: `merge ${branch.mergeJob.state}`,
			tone: branch.mergeJob.state === "parked" ? "critical" : "info",
		});
	}
	if (branch.run?.live) {
		out.push({ key: "live", label: "run live", tone: "accent" });
	}
	if (branch.kind === "remote") {
		out.push({ key: "remote", label: "remote", tone: "neutral" });
	}
	return out;
}

export type BranchKind =
	| "all"
	| "local"
	| "remote"
	| "mfw"
	| "wip"
	| "unmerged"
	| "merged"
	| "stale";

export const BRANCH_KINDS: { id: BranchKind; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "local", label: "Local" },
	{ id: "remote", label: "Remote" },
	{ id: "mfw", label: "mfw runs" },
	{ id: "wip", label: "wip" },
	{ id: "unmerged", label: "Unmerged" },
	{ id: "merged", label: "Merged" },
	{ id: "stale", label: "Stale" },
];

export function parseBranchKind(value: string | undefined): BranchKind {
	return BRANCH_KINDS.some((k) => k.id === value)
		? (value as BranchKind)
		: "all";
}

/**
 * Filter by kind chip and free text. Text matches the branch name, its
 * task id, its last subject and author; every whitespace-separated term has to
 * hit (AND), case-insensitively.
 */
export function filterBranches<T extends BranchLike>(
	branches: readonly T[],
	opts: { q?: string; kind?: BranchKind; nowMs: number },
): T[] {
	const kind = opts.kind ?? "all";
	const terms = (opts.q ?? "")
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 0);
	return branches.filter((b) => {
		const kindOk =
			kind === "all" ||
			(kind === "local" && b.kind === "local") ||
			(kind === "remote" && b.kind === "remote") ||
			(kind === "mfw" && b.mfw === "run") ||
			(kind === "wip" && b.mfw === "wip") ||
			(kind === "unmerged" && !b.merged && !b.isIntegration) ||
			(kind === "merged" && b.merged && !b.isIntegration) ||
			(kind === "stale" && isStale(b, opts.nowMs));
		if (!kindOk) return false;
		if (terms.length === 0) return true;
		const hay = [
			b.name,
			b.run?.taskId ?? "",
			b.lastCommit.subject,
			b.lastCommit.author,
		]
			.join("\n")
			.toLowerCase();
		return terms.every((t) => hay.includes(t));
	});
}

/** Counts for the kind chips, over the unfiltered list. */
export function kindCounts<T extends BranchLike>(
	branches: readonly T[],
	nowMs: number,
): Record<BranchKind, number> {
	const out = {} as Record<BranchKind, number>;
	for (const { id } of BRANCH_KINDS) {
		out[id] = filterBranches(branches, { kind: id, nowMs }).length;
	}
	return out;
}

/** The branch a run's `mfw/<id>` name implies, for links that only know a run id. */
export function runBranchName(runId: string): string {
	return `mfw/${runId}`;
}

// ---------------------------------------------------------------------------
// graph
// ---------------------------------------------------------------------------

export interface GraphInput {
	sha: string;
	parents: readonly string[];
}

export interface GraphRow {
	sha: string;
	/** The lane the commit's dot sits in. */
	lane: number;
	/** Lanes carrying an unrelated line straight through this row. */
	through: number[];
	/** Lanes that arrive at this commit from above and end here (it is their parent). */
	mergesIn: number[];
	/** Whether the commit's own lane had a line arriving from above. */
	hasChildAbove: boolean;
	/** Lanes the commit's parents continue in, in parent order. */
	parentLanes: number[];
	/** Lanes in use after this row; the drawing's width. */
	width: number;
}

/**
 * Lane assignment for a log in order children-before-parents (what
 * `git log --date-order` emits). Each lane holds the sha it expects next:
 *
 *  - a commit takes the leftmost lane expecting it, else the first free lane;
 *  - any other lane expecting it ends here (`mergesIn`);
 *  - its first parent keeps the lane, later parents take the lane already
 *    expecting them or a free one (a merge opens lines to the right);
 *  - a first parent already expected elsewhere closes this lane instead.
 *
 * Pages of one log can be concatenated and run once: the result for earlier
 * rows does not depend on later ones.
 */
export function assignLanes(commits: readonly GraphInput[]): GraphRow[] {
	const lanes: (string | null)[] = [];
	const rows: GraphRow[] = [];

	const freeLane = (): number => {
		const i = lanes.indexOf(null);
		if (i >= 0) return i;
		lanes.push(null);
		return lanes.length - 1;
	};

	for (const commit of commits) {
		const expecting: number[] = [];
		lanes.forEach((s, i) => {
			if (s === commit.sha) expecting.push(i);
		});
		const hasChildAbove = expecting.length > 0;
		const lane = expecting[0] ?? freeLane();
		const mergesIn = expecting.slice(1);
		const through: number[] = [];
		lanes.forEach((s, i) => {
			if (s !== null && s !== commit.sha) through.push(i);
		});
		for (const i of mergesIn) lanes[i] = null;
		lanes[lane] = null;

		const parentLanes: number[] = [];
		commit.parents.forEach((parent, index) => {
			const existing = lanes.indexOf(parent);
			if (existing >= 0) {
				parentLanes.push(existing);
				return;
			}
			if (index === 0) {
				lanes[lane] = parent;
				parentLanes.push(lane);
			} else {
				const i = freeLane();
				lanes[i] = parent;
				parentLanes.push(i);
			}
		});

		// Trim trailing free lanes so the drawing does not stay wide forever.
		while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
		rows.push({
			sha: commit.sha,
			lane,
			through,
			mergesIn,
			hasChildAbove,
			parentLanes,
			width: Math.max(lanes.length, lane + 1, ...parentLanes.map((p) => p + 1)),
		});
	}
	return rows;
}

/** The widest row, for sizing one SVG column for the whole list. */
export function graphWidth(rows: readonly GraphRow[]): number {
	return rows.reduce(
		(w, r) => Math.max(w, r.width, r.lane + 1, ...r.mergesIn.map((m) => m + 1)),
		1,
	);
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

/** `+12 −3`; null counts (binary) read as `bin`. */
export function formatStat(
	added: number | null,
	deleted: number | null,
): { added: string; deleted: string; binary: boolean } {
	if (added === null || deleted === null) {
		return { added: "", deleted: "", binary: true };
	}
	return { added: `+${added}`, deleted: `−${deleted}`, binary: false };
}

/** Porcelain XY to words, for the worktree changes list. */
export function describeXY(
	index: string,
	worktree: string,
	untracked: boolean,
): string {
	if (untracked) return "untracked";
	const word = (c: string) =>
		c === "M"
			? "modified"
			: c === "A"
				? "added"
				: c === "D"
					? "deleted"
					: c === "R"
						? "renamed"
						: c === "C"
							? "copied"
							: c === "U"
								? "conflicted"
								: c === "T"
									? "type changed"
									: "";
	const staged = word(index);
	const unstaged = word(worktree);
	if (staged && unstaged) return `${staged} (staged), ${unstaged} (unstaged)`;
	if (staged) return `${staged} (staged)`;
	return unstaged || "changed";
}
