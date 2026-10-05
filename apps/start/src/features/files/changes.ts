import type { RouterOutputs } from "../../lib/trpc";

/**
 * Git status classification for the listing. `files.gitStatus` returns raw
 * porcelain XY pairs: the INDEX column is staged, the WORKTREE column is not, and
 * the two must stay distinct. The summary bar and rows share this one classification.
 */

export type GitFile = RouterOutputs["files"]["gitStatus"]["files"][number];
export type GitStatus = RouterOutputs["files"]["gitStatus"];

/** Change states mapped to the app's semantic tones. */
export type ChangeTone = "ok" | "warn" | "info" | "critical";

export interface ChangeCounts {
	staged: number;
	unstaged: number;
	untracked: number;
	conflicted: number;
}

/** What a directory holds, without opening it. */
export interface Inside {
	count: number;
	/** Most urgent tone anywhere below (a conflict must not hide). */
	tone: ChangeTone;
}

export interface Changes {
	/** Base-relative path → its porcelain record. */
	file: Map<string, GitFile>;
	/** Base-relative directory → what changed anywhere below it. */
	under: Map<string, Inside>;
	counts: ChangeCounts;
}

const NO_CHANGES: Changes = {
	file: new Map(),
	under: new Map(),
	counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
};

/** Index the status once by path and by every ancestor directory, so directory rows show change counts without opening. */
export function indexChanges(files: readonly GitFile[]): Changes {
	if (files.length === 0) return NO_CHANGES;
	const byPath = new Map<string, GitFile>();
	const under = new Map<string, Inside>();
	const counts: ChangeCounts = {
		staged: 0,
		unstaged: 0,
		untracked: 0,
		conflicted: 0,
	};

	for (const file of files) {
		byPath.set(file.path, file);
		const tone = toneOf(file);
		// A rename's old directory still lost a file, so count `from` too.
		for (const path of file.from ? [file.path, file.from] : [file.path]) {
			let cut = path.indexOf("/");
			while (cut !== -1) {
				const dir = path.slice(0, cut);
				const seen = under.get(dir);
				under.set(dir, {
					count: (seen?.count ?? 0) + 1,
					tone: seen && URGENCY[seen.tone] >= URGENCY[tone] ? seen.tone : tone,
				});
				cut = path.indexOf("/", cut + 1);
			}
		}

		if (isConflicted(file)) counts.conflicted += 1;
		else if (file.index === "?") counts.untracked += 1;
		else {
			// Both columns can be set ("MM"); count both, as git reports.
			if (file.index !== " " && file.index !== "!") counts.staged += 1;
			if (file.worktree !== " " && file.worktree !== "!") counts.unstaged += 1;
		}
	}

	return { file: byPath, under, counts };
}

/** Which tone survives when a directory holds several. */
const URGENCY: Record<ChangeTone, number> = {
	critical: 3,
	warn: 2,
	info: 1,
	ok: 0,
};

/** The unmerged porcelain pairs, per `git status` documentation. */
function isConflicted(file: GitFile): boolean {
	if (file.index === "U" || file.worktree === "U") return true;
	return (
		file.index === file.worktree && (file.index === "A" || file.index === "D")
	);
}

/** One tone per row: fully staged is `ok`; anything left in the worktree is `warn` (it is lost if the run ends). */
export function toneOf(file: GitFile): ChangeTone {
	if (isConflicted(file)) return "critical";
	if (file.index === "?") return "info";
	if (file.worktree !== " " && file.worktree !== "!") return "warn";
	return "ok";
}

/** Tone for a single porcelain column, so the two can disagree on screen. */
export function columnTone(
	file: GitFile,
	column: "index" | "worktree",
): ChangeTone | null {
	if (isConflicted(file)) return "critical";
	const code = file[column];
	if (code === "?") return "info";
	if (code === " " || code === "!") return null;
	return column === "index" ? "ok" : "warn";
}

/** Porcelain letters, in words. */
const WORDS: Record<string, string> = {
	"?": "untracked",
	"!": "ignored",
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
	T: "type changed",
	U: "conflicted",
};

/** The full truth about a change, for a `title` an operator can hover. */
export function describe(file: GitFile): string {
	if (isConflicted(file)) {
		return `conflicted (${file.index}${file.worktree})`;
	}
	if (file.index === "?") return "untracked: not in git";
	const parts: string[] = [];
	if (file.index !== " ") {
		parts.push(`staged: ${WORDS[file.index] ?? file.index}`);
	}
	if (file.worktree !== " ") {
		parts.push(`unstaged: ${WORDS[file.worktree] ?? file.worktree}`);
	}
	if (file.from) parts.push(`from ${file.from}`);
	return parts.length > 0 ? parts.join(" · ") : "unchanged";
}
