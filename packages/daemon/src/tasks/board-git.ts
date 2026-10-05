import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { git } from "../git.ts";
import type { Logger } from "../log.ts";

/**
 * Commits the board (`.mfw/tasks/`, `.mfw/adrs/`, `.mfw/board.yaml`) on the
 * integration branch, path-scoped and debounced, so the human's staged and
 * unstaged work is left untouched. Refuses to commit when the checkout is in
 * a state where that would be wrong (see `canCommit()`). Run worktrees
 * exclude the board (`worktree.ts`) and the merge queue restores it
 * (`merge-queue.ts`).
 */

/**
 * Repo-relative paths this class stages. Narrower than the `.mfw/` exclusion
 * in `worktree.ts` / `merge-queue.ts`: widening it would `git add -A` the
 * database (`.mfw/mfw.db`, `.mfw/runs/`). `board.yaml` is included: the new
 * board layer writes it directly under `.mfw/`, outside `tasks/`/`adrs/`.
 */
function relPaths(projectRoot: string, mfwDir: string): readonly string[] {
	return [
		relative(projectRoot, join(mfwDir, "tasks")),
		relative(projectRoot, join(mfwDir, "adrs")),
		relative(projectRoot, join(mfwDir, "board.yaml")),
	];
}

export interface BoardRepoDeps {
	projectRoot: string;
	mfwDir: string;
	/** The branch the board belongs to. Commits happen on this branch or not at all. */
	integrationBranch: string;
	log: Logger;
	/** Minimum gap between commits; changes inside it coalesce into one. */
	minIntervalMs?: number;
	now?: () => number;
}

/** Why a commit was refused, or null when it may proceed. */
export type Refusal =
	| { kind: "branch"; head: string }
	| { kind: "in-progress"; op: string }
	| { kind: "suspended" };

export class BoardRepo {
	private readonly now: () => number;
	private readonly minIntervalMs: number;
	private dirty = false;
	private lastCommitAt = 0;
	private chain: Promise<unknown> = Promise.resolve();
	/** False when the project is not a git repo, or the board is git-ignored. */
	private enabled = false;
	/** The refusal we last logged, so a week on a feature branch is one line. */
	private loggedRefusal: string | null = null;
	/** Set by the task store's circuit breaker; committing a distrusted board would make a `reset --hard` or stale checkout permanent. */
	private suspended = false;

	constructor(private readonly deps: BoardRepoDeps) {
		this.now = deps.now ?? (() => Date.now());
		this.minIntervalMs = deps.minIntervalMs ?? 3000;
	}

	get isEnabled(): boolean {
		return this.enabled;
	}

	/** Something wrote to the board; commit it on the next tick. */
	touch(): void {
		this.dirty = true;
	}

	/** The circuit breaker tripped (or cleared). While tripped, no commits. */
	setSuspended(on: boolean): void {
		this.suspended = on;
	}

	private get paths(): readonly string[] {
		return relPaths(this.deps.projectRoot, this.deps.mfwDir);
	}

	/** Idempotent; a no-op (unversioned board) outside a git repo or when the board is git-ignored. */
	async ensureTracked(): Promise<{ enabled: boolean }> {
		const { projectRoot, log } = this.deps;
		if (!existsSync(join(projectRoot, ".git"))) {
			log.info(
				"project is not a git repository, the board is plain files, unversioned",
			);
			return { enabled: false };
		}

		// `tasks/`/`adrs/` must actually EXIST as directories before the
		// check-ignore loop below: a `!/.mfw/adrs/` negation (trailing slash)
		// only reliably un-ignores a path git can confirm is a directory, so a
		// not-yet-created `adrs/` reads as still-ignored even with the exception
		// in place. `board.yaml` is a bare file negation, no such requirement.
		await mkdir(join(this.deps.mfwDir, "tasks"), { recursive: true });
		await mkdir(join(this.deps.mfwDir, "adrs"), { recursive: true });

		// An ignored board makes every commit a silent no-op; carry on unversioned.
		for (const p of this.paths) {
			const ignored = await git(["check-ignore", "-q", "--", p], projectRoot);
			if (ignored.exitCode === 0) {
				log.warn(
					{ path: p },
					"the board is git-ignored in this project, so it cannot be committed, " +
						"the board still works, it is just unversioned",
				);
				return { enabled: false };
			}
		}

		this.enabled = true;
		return { enabled: true };
	}

	/** Is HEAD the board's branch? Gates reading as well as writing. */
	async onIntegrationBranch(): Promise<boolean> {
		if (!this.enabled) return true; // nothing to be off-branch from
		const head = await git(
			["symbolic-ref", "-q", "HEAD"],
			this.deps.projectRoot,
		);
		return (
			head.exitCode === 0 &&
			head.stdout.trim() === `refs/heads/${this.deps.integrationBranch}`
		);
	}

	/**
	 * Reasons to refuse a board commit:
	 *  - HEAD is not the integration branch (a detached HEAD commit succeeds and
	 *    is orphaned; on another branch it pollutes that branch's diff).
	 *  - a merge/rebase/cherry-pick/revert/bisect is in progress (git rejects
	 *    partial commits mid-merge, exit 128).
	 *  - the circuit breaker has tripped.
	 */
	private async canCommit(): Promise<Refusal | null> {
		if (this.suspended) return { kind: "suspended" };

		// Before the branch check: a conflicted rebase detaches HEAD, and the op is the more useful reason.
		const gitDir = await git(["rev-parse", "--git-dir"], this.deps.projectRoot);
		if (gitDir.exitCode === 0) {
			const dir = gitDir.stdout.trim();
			const abs = dir.startsWith("/") ? dir : join(this.deps.projectRoot, dir);
			for (const [file, op] of [
				["MERGE_HEAD", "merge"],
				["rebase-merge", "rebase"],
				["rebase-apply", "rebase"],
				["CHERRY_PICK_HEAD", "cherry-pick"],
				["REVERT_HEAD", "revert"],
				["BISECT_LOG", "bisect"],
			] as const) {
				if (existsSync(join(abs, file))) return { kind: "in-progress", op };
			}
		}

		const head = await git(
			["symbolic-ref", "-q", "HEAD"],
			this.deps.projectRoot,
		);
		const ref = head.exitCode === 0 ? head.stdout.trim() : "(detached)";
		if (ref !== `refs/heads/${this.deps.integrationBranch}`) {
			return { kind: "branch", head: ref };
		}
		return null;
	}

	/** Log a refusal the first time we see it, and the recovery once too. */
	private noteRefusal(r: Refusal | null): void {
		const key =
			r === null
				? null
				: r.kind === "branch"
					? `branch:${r.head}`
					: r.kind === "in-progress"
						? `op:${r.op}`
						: "suspended";
		if (key === this.loggedRefusal) return;
		if (key === null) {
			this.deps.log.info("board commits resumed");
		} else if (r?.kind === "branch") {
			this.deps.log.warn(
				{ head: r.head, branch: this.deps.integrationBranch },
				"not committing the board: HEAD is not the integration branch. The " +
					"board on disk belongs to whatever is checked out, so committing it " +
					"here would strand it on the wrong branch",
			);
		} else if (r?.kind === "in-progress") {
			this.deps.log.warn(
				{ op: r.op },
				`not committing the board: a ${r.op} is in progress`,
			);
		} else {
			this.deps.log.warn(
				"not committing the board: the board is suspended (see board.suspended)",
			);
		}
		this.loggedRefusal = key;
	}

	/** Commit if dirty and the coalescing window has passed. Called from the supervisor pass. */
	async tick(force = false): Promise<string | null> {
		if (!this.enabled) return null;
		if (!force && !this.dirty) return null;
		if (!force && this.now() - this.lastCommitAt < this.minIntervalMs) {
			return null;
		}
		return this.serialize(() => this.commitNow());
	}

	/** Commit whatever is pending right now (shutdown, tests, maintenance). */
	async flush(): Promise<string | null> {
		if (!this.enabled) return null;
		return this.serialize(() => this.commitNow());
	}

	private serialize<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.chain.then(fn, fn);
		this.chain = next.catch(() => {
			// keep the chain settled; the caller still sees the rejection
		});
		return next;
	}

	private async commitNow(message?: string): Promise<string | null> {
		const refusal = await this.canCommit();
		this.noteRefusal(refusal);
		// Keep `dirty`: a refused commit is deferred, not dropped.
		if (refusal) return null;

		const { projectRoot, log } = this.deps;
		// `git add` exits 128 on a missing path (e.g. no ADRs yet).
		const paths = this.paths.filter((p) => existsSync(join(projectRoot, p)));
		if (paths.length === 0) return null;

		const staged = await this.withLockRetry(() =>
			git(["add", "-A", "--", ...paths], projectRoot),
		);
		if (staged.exitCode !== 0) {
			// `dirty` stays set so the next tick retries.
			log.error(
				{ stderr: staged.stderr.trim() },
				"could not stage board changes, the board is NOT committed",
			);
			return null;
		}

		const described = await this.describeStaged(paths);
		if (described === null) {
			// Nothing to record: settled.
			this.dirty = false;
			return null;
		}
		const summary = message ?? described.summary;

		const commit = await this.withLockRetry(() =>
			git(
				[
					"-c",
					"user.name=mfw",
					"-c",
					"user.email=mfw@localhost",
					"commit",
					"-q",
					// Skip hooks (husky/lefthook): a failing hook would wedge the board
					// out of git. Safe because these commits only touch `.mfw/tasks`
					// and `.mfw/adrs`.
					"--no-verify",
					"-m",
					summary,
					// Files, not directories: `git commit -- <dir>` fails on a pathspec
					// git knows nothing about (e.g. an empty `.mfw/adrs/`).
					"--",
					...described.paths,
				],
				projectRoot,
			),
		);
		if (commit.exitCode !== 0) {
			log.error(
				{ stderr: commit.stderr.trim() },
				"could not commit board changes, the board is NOT committed",
			);
			return null;
		}
		this.dirty = false;
		this.lastCommitAt = this.now();
		return summary;
	}

	/**
	 * Retry `.git/index.lock` collisions with the human's git, and only those
	 * (they can lose writes while both callers exit 0). Other errors go to the
	 * caller's `log.error`.
	 */
	private async withLockRetry<
		T extends { exitCode: number; stderr: string; stdout: string },
	>(run: () => Promise<T>): Promise<T> {
		const backoff = [50, 150, 400];
		let last = await run();
		for (const ms of backoff) {
			if (
				last.exitCode === 0 ||
				!/index\.lock|Unable to create/i.test(last.stderr)
			) {
				return last;
			}
			await new Promise((r) => setTimeout(r, ms));
			last = await run();
		}
		return last;
	}

	/**
	 * Commit message from the staged diff. Status is now a frontmatter field
	 * (MFW-ADR-22), not a directory, and every document's path is frozen at
	 * creation — a rename essentially never happens anymore (only a stray hand
	 * rename would produce one), so this can no longer report a status
	 * transition like the old `MFW-4: ready → done`; the content-edit branch
	 * (`${id} edited`) is what a status change looks like now, same as any
	 * other field edit.
	 */
	private async describeStaged(
		paths: readonly string[],
	): Promise<{ summary: string; paths: string[] } | null> {
		const diff = await git(
			["diff", "--cached", "--name-status", "-M", "--", ...paths],
			this.deps.projectRoot,
		);
		if (diff.exitCode !== 0) return null;
		const lines = diff.stdout.split("\n").filter((l) => l.trim().length > 0);
		if (lines.length === 0) return null;

		const parts = new Set<string>();
		const touched = new Set<string>();
		for (const line of lines) {
			const cols = line.split("\t");
			const code = (cols[0] ?? "").trim();
			const a = cols[1] ?? "";
			const b = cols[2] ?? "";
			if (a) touched.add(a);
			if (b) touched.add(b);
			if (code.startsWith("R")) {
				const from = whereOf(a);
				const to = whereOf(b);
				parts.add(
					from === to ? `${idOf(b)} renamed` : `${idOf(b)}: ${from} → ${to}`,
				);
			} else if (code.startsWith("A")) {
				parts.add(`${idOf(a)} added (${whereOf(a)})`);
			} else if (code.startsWith("D")) {
				parts.add(`${idOf(a)} removed`);
			} else {
				parts.add(`${idOf(a)} edited`);
			}
		}
		if (parts.size === 0) return null;
		// A task is a directory, so one edit can touch several files; the set dedupes.
		const all = [...parts];
		const head = all.slice(0, 3).join(", ");
		const rest = all.length > 3 ? ` (+${all.length - 3} more)` : "";
		return { summary: `mfw: ${head}${rest}`, paths: [...touched] };
	}
}

/** `.mfw/tasks/MFW-4-slug/task.md` → `task`, `.mfw/adrs/MFW-ADR-1-y.md` → `adr`, `.mfw/board.yaml` → `(root)`. */
function whereOf(path: string): string {
	const parts = path.split("/").filter((p) => p !== "" && p !== ".mfw");
	if (parts[0] === "adrs") return "adr";
	// Flat now: `tasks/<id-slug>/…` is a task; a bare `tasks/<file>` has no
	// `mfw:` marker (see MFW-ADR-22) so it is not adopted and should not appear here.
	if (parts[0] === "tasks") return parts.length > 1 ? "task" : "(root)";
	return parts.length > 1 ? (parts[0] as string) : "(root)";
}

/** `.mfw/tasks/MFW-4-slug/task.md` → `MFW-4`, `.mfw/adrs/MFW-ADR-1-y.md` → `MFW-ADR-1`, falling back to the name. */
function idOf(path: string): string {
	const parts = path.split("/").filter((p) => p !== "" && p !== ".mfw");
	const name =
		(parts[0] === "tasks" || parts[0] === "adrs" ? parts[1] : parts.at(-1)) ??
		path;
	const stem = name.replace(/\.md$/, "");
	const m = /^([A-Z][A-Z0-9]{1,9}-(?:ADR-)?[1-9][0-9]*)/.exec(stem);
	return m ? (m[1] as string) : stem;
}
