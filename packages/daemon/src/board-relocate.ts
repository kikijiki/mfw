import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rmdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { git } from "./git.ts";
import type { Logger } from "./log.ts";

/**
 * The board used to live in `<boardFolder>/.mfw/`; it now lives at the root of
 * the board folder. This is the one place that still knows the old layout: it
 * moves a legacy board out of `.mfw/` once, so an existing project attaches
 * without a manual step.
 *
 * Only board files move to the folder root. Machine state that sat beside them
 * (`state/`, the id counters in `.board/`) belongs to the daemon and goes to
 * `daemonDir` (the repository's `.mfw/`), merged without overwriting.
 */

/** Board entries that move from `.mfw/` to the folder root. */
const BOARD_ENTRIES = ["board.yaml", "tasks", "adrs", "templates"] as const;
/** Daemon state that moves to `daemonDir` when the two differ. */
const STATE_ENTRIES = ["state", ".board"] as const;

export const RELOCATE_COMMIT_MESSAGE = "mfw: move the board out of .mfw";

export interface RelocateResult {
	/** Folder-relative names that were moved to the folder root. */
	moved: string[];
	/** The sha of the commit recording the move, when one was made. */
	committed: string | null;
}

/**
 * Move a legacy `<boardFolder>/.mfw/` board to `<boardFolder>/`. Idempotent:
 * nothing to do once `board.yaml` is at the folder root. Refuses, changing
 * nothing, when a destination already exists.
 */
export async function relocateLegacyBoard(opts: {
	boardFolder: string;
	daemonDir: string;
	log: Logger;
}): Promise<RelocateResult> {
	const folder = resolve(opts.boardFolder);
	const daemonDir = resolve(opts.daemonDir);
	const legacy = join(folder, ".mfw");
	const none: RelocateResult = { moved: [], committed: null };

	// A legacy board is recognised by its board.yaml, or by a tasks directory
	// from before board.yaml was written.
	const isLegacy =
		existsSync(join(legacy, "board.yaml")) || existsSync(join(legacy, "tasks"));
	if (!isLegacy) return none;
	if (existsSync(join(folder, "board.yaml"))) {
		opts.log.warn(
			{ folder },
			"both board.yaml and .mfw/board.yaml exist; leaving both, remove the stale one",
		);
		return none;
	}

	const entries = BOARD_ENTRIES.filter((n) => existsSync(join(legacy, n)));
	for (const name of entries) {
		const dest = join(folder, name);
		if (existsSync(dest)) {
			throw new Error(
				`cannot move the board out of ${legacy}: ${dest} already exists; ` +
					"move or remove it and attach again (nothing was changed)",
			);
		}
	}

	// Which of the sources git tracks, before anything moves.
	const tracked: string[] = [];
	const inWorkTree = await isWorkTree(folder);
	if (inWorkTree) {
		for (const name of entries) {
			const src = relative(folder, join(legacy, name));
			const listed = await git(["ls-files", "-z", "--", src], folder);
			if (listed.exitCode === 0 && listed.stdout.length > 0) tracked.push(src);
		}
	}

	for (const name of entries) {
		await rename(join(legacy, name), join(folder, name));
	}
	if (legacy !== daemonDir) {
		for (const name of STATE_ENTRIES) {
			await mergeInto(join(legacy, name), join(daemonDir, name), opts.log);
		}
	}
	// Only when empty: whatever else a human kept there stays.
	await rmdir(legacy).catch(() => {});

	let committed: string | null = null;
	if (inWorkTree && entries.length > 0) {
		committed = await commitMove(folder, entries, tracked, opts.log);
	}
	opts.log.info({ folder, moved: entries }, "moved the board out of .mfw");
	return { moved: [...entries], committed };
}

async function isWorkTree(dir: string): Promise<boolean> {
	const r = await git(["rev-parse", "--is-inside-work-tree"], dir);
	return r.exitCode === 0 && r.stdout === "true";
}

/** Move `from` to `to`; where `to` exists, merge directories and keep the
 * destination's files (the source file stays where it is). */
async function mergeInto(from: string, to: string, log: Logger): Promise<void> {
	if (!existsSync(from)) return;
	if (!existsSync(to)) {
		await mkdir(dirname(to), { recursive: true });
		await rename(from, to);
		return;
	}
	const children = await readdir(from, { withFileTypes: true }).catch(() => []);
	for (const child of children) {
		const src = join(from, child.name);
		const dst = join(to, child.name);
		if (child.isDirectory()) {
			await mergeInto(src, dst, log);
		} else if (existsSync(dst)) {
			log.warn({ kept: dst, left: src }, "state file exists in both places");
		} else {
			await mkdir(to, { recursive: true });
			await rename(src, dst);
		}
	}
	await rmdir(from).catch(() => {});
}

/** Stage the move and commit exactly those paths. Failure is logged, not
 * thrown: the files are already where they belong. */
async function commitMove(
	folder: string,
	entries: readonly string[],
	trackedSources: readonly string[],
	log: Logger,
): Promise<string | null> {
	// Deletions of what git tracked, plus the new locations. A new path git
	// ignores is skipped (the user chose that), never forced.
	const specs = [...trackedSources, ...entries];
	const touched = new Set<string>();
	for (const spec of specs) {
		const added = await git(["add", "-A", "--", spec], folder);
		if (added.exitCode !== 0) {
			log.warn(
				{ path: spec, stderr: added.stderr },
				"could not stage a moved board path",
			);
			continue;
		}
		const staged = await git(
			["diff", "--cached", "--relative", "--name-only", "-z", "--", spec],
			folder,
		);
		for (const p of staged.stdout.split("\0").filter(Boolean)) touched.add(p);
	}
	if (touched.size === 0) return null;
	const commit = await git(
		[
			"-c",
			"user.name=mfw",
			"-c",
			"user.email=mfw@localhost",
			"commit",
			"-q",
			"--no-verify",
			"-m",
			RELOCATE_COMMIT_MESSAGE,
			"--",
			...touched,
		],
		folder,
	);
	if (commit.exitCode !== 0) {
		log.warn({ stderr: commit.stderr }, "could not commit the board move");
		return null;
	}
	const head = await git(["rev-parse", "HEAD"], folder);
	return head.exitCode === 0 ? head.stdout : null;
}

/**
 * The board folder holds a `tasks` directory but no `board.yaml`: that is
 * somebody's own directory, not a board. Creating a board over it would adopt
 * (and in time rewrite) files that were never ours, so the attach refuses.
 */
export async function assertNoForeignTasksDir(
	boardFolder: string,
): Promise<void> {
	if (existsSync(join(boardFolder, "board.yaml"))) return;
	const tasks = join(boardFolder, "tasks");
	if (existsSync(tasks)) {
		throw new Error(
			`${tasks} exists but there is no board.yaml beside it, so it is not an mfw board; ` +
				"choose a separate board folder for this project, or rename or remove that directory",
		);
	}
}
