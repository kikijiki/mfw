import { createHash, randomUUID } from "node:crypto";
import {
	access,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readProtectedBoardPaths } from "./board-layout.ts";
import { git, gitOk } from "./git.ts";

export interface Worktree {
	path: string;
	branch: string;
	baseSha: string;
}

export interface OwnedWorktree extends Worktree {
	runId: string;
}

/** A run's work saved on a plain branch by `WorktreeManager.archiveWip`. */
export interface WipArchive {
	/** Short branch name, `wip/<task>-<run>` (a `-<n>` suffix if taken). */
	ref: string;
	sha: string;
	/** False when an identical archive already existed. */
	created: boolean;
}

export type WorktreeReportIdentity =
	| { state: "absent" }
	| { state: "present"; sha256: string };

interface WorktreeContentOptions {
	/** Exact worktree report state committed by ingest_report. */
	reportIdentity?: WorktreeReportIdentity;
}

const OWNER_RUN_ID = "mfw.owner-run-id";
const OWNER_BRANCH = "mfw.owner-branch";
const OWNER_BASE_SHA = "mfw.owner-base-sha";

/**
 * Git worktree lifecycle (backstage architecture.md, "Runs"). Each task runs in its own
 * worktree on its own branch so concurrent agents never collide. Clean
 * worktrees are auto-removed; dirty ones are preserved for review (Factory
 * `droid exec -w` semantics).
 */
export class WorktreeManager {
	/** `<repoRoot>/worktrees` */
	readonly dir: string;

	constructor(public readonly repoRoot: string) {
		this.dir = join(repoRoot, "worktrees");
	}

	/** Create a worktree on a fresh branch off `base` (default: current HEAD). */
	async create(runId: string, base = "HEAD"): Promise<Worktree> {
		await mkdir(this.dir, { recursive: true });
		const branch = `mfw/${runId}`;
		const path = join(this.dir, runId);
		const baseSha = await gitOk(["rev-parse", base], this.repoRoot);
		// `--no-checkout` first so the board is never on disk, even briefly,
		// before the sparse rules apply.
		await gitOk(
			["worktree", "add", "--no-checkout", "-b", branch, path, baseSha],
			this.repoRoot,
		);
		try {
			await this.excludeBoard(path);
			// Durable provenance lives in Git's per-worktree config; a run row or a
			// familiar path/branch name can be stale or manually recreated.
			await gitOk(["config", "--worktree", OWNER_RUN_ID, runId], path);
			await gitOk(["config", "--worktree", OWNER_BRANCH, branch], path);
			await gitOk(["config", "--worktree", OWNER_BASE_SHA, baseSha], path);
			await gitOk(["checkout"], path);
			await this.deliverAgentRules(path);
			return { path, branch, baseSha };
		} catch (e) {
			// `git worktree add` already registered the path and branch; roll both
			// back since the caller never receives the Worktree.
			await git(["worktree", "remove", "--force", path], this.repoRoot);
			await git(["branch", "-D", branch], this.repoRoot);
			await rm(path, { recursive: true, force: true });
			throw e;
		}
	}

	/**
	 * Make everything mfw owns except trigger definitions unreachable from a
	 * run worktree. The board is tracked on the integration branch, so without
	 * this an agent could `git add -A` a stale or edited board back over the
	 * live one. With these patterns (checked on git 2.54) the board files are
	 * `skip-worktree` and absent from disk, `git add -A` stages nothing,
	 * `git add -f` exits 1 and `git commit -a` finds nothing.
	 *
	 * Non-cone mode, because cone mode can only include directories and would
	 * have to enumerate every top-level path in the user's repo.
	 *
	 * The exclusion covers all of `.mfw/` except `.mfw/triggers/**`, not just
	 * `tasks/` and `specs/` (MFW-117 §3): `.mfw/lifetime/` is tracked and a
	 * definition written there merges, letting an agent author a recurring task
	 * that creates tasks forever. `.mfw/AGENTS.md` and `.mfw/config.yaml` were
	 * equally reachable. Trigger definitions are the exception: they are
	 * code-review artifacts and cannot execute until an operator arms their
	 * exact hash.
	 *
	 * The board itself (`board.yaml` and each document type's directory at the
	 * root of the board folder, see `board-layout.ts`) is excluded the same way
	 * when the board folder is inside this repository.
	 *
	 * AGENTS.md must still be readable; see `deliverAgentRules`.
	 *
	 * `sparse-checkout` sets `extensions.worktreeConfig` and writes
	 * `core.sparseCheckout` into the per-worktree config. In the shared config
	 * it would apply to the primary checkout and hide the human's board.
	 */
	private async excludeBoard(worktreePath: string): Promise<void> {
		const board = await readProtectedBoardPaths(this.repoRoot);
		const r = await git(
			[
				"sparse-checkout",
				"set",
				"--no-cone",
				"/*",
				"!/.mfw/*",
				"/.mfw/triggers/",
				...board.map((p) => `!/${p}`),
			],
			worktreePath,
		);
		if (r.exitCode !== 0) {
			// Fail closed: a worktree that carries the board is one an agent can
			// damage, and a failed start beats a silently absent defence.
			throw new Error(`sparse-checkout failed: ${r.stderr || r.stdout}`);
		}
	}

	/**
	 * Copy `.mfw/AGENTS.md` into the worktree as a plain file, after checkout.
	 * An agent must be able to read its rules but not rewrite and merge them;
	 * re-including the path in the sparse rules would allow both, so the file
	 * is written over a path the sparse rules exclude.
	 *
	 * Checked on git 2.54: writing to a sparse-excluded path clears its
	 * `skip-worktree` bit at the next index refresh, so an edit shows in
	 * `git status`, but `git add -A`, `git add -f` and `git commit -a` still
	 * refuse to stage it (sparse rules apply at the `add` layer). Only a
	 * deliberate `git add --sparse` stages an edit, and the merge queue's
	 * firewall reverts that. An unedited copy is identical to HEAD's, so a clean
	 * worktree is still reaped; an edited one is dirty and preserved.
	 *
	 * Read from the primary checkout's working tree, not `baseSha`, so a run
	 * started with an uncommitted rules edit sees it. Best-effort: no AGENTS.md
	 * means no copy.
	 */
	private async deliverAgentRules(worktreePath: string): Promise<void> {
		let rules: string;
		try {
			rules = await readFile(join(this.repoRoot, ".mfw", "AGENTS.md"), "utf8");
		} catch {
			return; // no rules file in this project
		}
		await mkdir(join(worktreePath, ".mfw"), { recursive: true });
		await writeFile(join(worktreePath, ".mfw", "AGENTS.md"), rules);
	}

	/** True if the worktree has local (including ignored) files or commits vs base. */
	async isDirty(
		wt: Worktree,
		opts: WorktreeContentOptions = {},
	): Promise<boolean> {
		if (await this.hasLocalChanges(wt, opts)) return true;
		const head = await git(["rev-parse", "HEAD"], wt.path);
		if (head.exitCode !== 0)
			throw new Error(
				`could not inspect worktree HEAD: ${head.stderr || head.stdout}`,
			);
		return head.stdout !== wt.baseSha;
	}

	/** Local files include ignored paths: ignored does not mean disposable.
	 * `MFW_REPORT.json` becomes disposable only after its finalize journal step
	 * is durably done; callers without that proof must preserve it as data. */
	async hasLocalChanges(
		wt: Pick<Worktree, "path">,
		opts: WorktreeContentOptions = {},
	): Promise<boolean> {
		let reportMatches = false;
		if (opts.reportIdentity) {
			const current = await this.reportIdentity(
				join(wt.path, "MFW_REPORT.json"),
			);
			if (
				current === null ||
				current.state !== opts.reportIdentity.state ||
				(current.state === "present" &&
					opts.reportIdentity.state === "present" &&
					current.sha256 !== opts.reportIdentity.sha256)
			) {
				return true;
			}
			reportMatches = true;
		}
		const status = await git(["status", "--porcelain"], wt.path);
		if (status.exitCode !== 0)
			throw new Error(
				`could not prove worktree clean: ${status.stderr || status.stdout}`,
			);
		if (status.stdout.length > 0) return true;

		const ignored = await git(
			["ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
			wt.path,
		);
		if (ignored.exitCode !== 0)
			throw new Error(
				`could not inspect ignored worktree data: ${ignored.stderr || ignored.stdout}`,
			);
		const ignoredPaths = ignored.stdout.split("\0").filter(Boolean);
		for (const path of ignoredPaths) {
			if (path === "MFW_REPORT.json" && reportMatches) continue;
			// This file is delivered by MFW (sparse checkout keeps the real copy
			// out). It is disposable only while byte-identical to the source.
			if (path !== ".mfw/AGENTS.md") return true;
			const [delivered, source] = await Promise.all([
				readFile(join(wt.path, path), "utf8").catch(() => null),
				readFile(join(this.repoRoot, path), "utf8").catch(() => null),
			]);
			if (delivered === null || source === null || delivered !== source)
				return true;
		}
		return false;
	}

	private async reportIdentity(
		path: string,
	): Promise<WorktreeReportIdentity | null> {
		try {
			const content = await readFile(path);
			return {
				state: "present",
				sha256: createHash("sha256").update(content).digest("hex"),
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return { state: "absent" };
			}
			return null;
		}
	}

	/**
	 * Remove a worktree if clean; preserve it (and its branch) if dirty so a
	 * human can review. Returns whether it was removed.
	 */
	async finalize(
		wt: Worktree,
		opts: WorktreeContentOptions = {},
	): Promise<{ removed: boolean }> {
		if (await this.isDirty(wt, opts)) return { removed: false };
		await this.remove(wt, {
			force: false,
			reportIdentity: opts.reportIdentity,
		});
		return { removed: true };
	}

	/**
	 * Return the durable MFW identity only when the current Git registration,
	 * path, branch and per-worktree marker all agree.
	 */
	async ownership(path: string): Promise<OwnedWorktree | null> {
		const owned = await this.markerAt(path);
		if (!owned) return null;
		if (resolve(path) !== resolve(this.dir, owned.runId)) return null;
		return owned;
	}

	/**
	 * Remove only a positively identified MFW worktree.
	 *
	 * Git first moves it to a unique quarantine path, closing the path-reuse
	 * race (anything recreated at the original path is not what we remove).
	 * Identity and (for non-force cleanup) dirty state are rechecked after the
	 * move. Branch deletion uses update-ref's compare-and-delete form, so a
	 * concurrently advanced or recreated ref survives.
	 */
	async remove(
		wt: Worktree,
		opts: {
			force?: boolean;
			deleteBranch?: boolean;
			reportIdentity?: WorktreeReportIdentity;
		} = {},
	): Promise<void> {
		const force = opts.force ?? true;
		const deleteBranch = opts.deleteBranch ?? true;
		const owned = await this.ownership(wt.path);
		if (!owned || owned.branch !== wt.branch || owned.baseSha !== wt.baseSha) {
			throw new Error(`refusing to remove unproven worktree '${wt.path}'`);
		}
		if (!force && (await this.hasLocalChanges(owned, opts))) {
			throw new Error(`refusing to remove dirty worktree '${wt.path}'`);
		}

		const tip = await git(["rev-parse", owned.branch], this.repoRoot);
		if (tip.exitCode !== 0)
			throw new Error(`could not resolve owned branch '${owned.branch}'`);
		const quarantineRoot = join(this.repoRoot, ".mfw", "worktree-trash");
		const quarantine = join(quarantineRoot, `${owned.runId}-${randomUUID()}`);
		await mkdir(quarantineRoot, { recursive: true });
		const moved = await git(
			["worktree", "move", owned.path, quarantine],
			this.repoRoot,
		);
		if (moved.exitCode !== 0) {
			throw new Error(
				`could not quarantine owned worktree '${owned.path}': ${moved.stderr || moved.stdout}`,
			);
		}

		const restore = async () => {
			await git(["worktree", "move", quarantine, owned.path], this.repoRoot);
		};
		const movedOwned = await this.markerAt(quarantine);
		if (
			!movedOwned ||
			movedOwned.runId !== owned.runId ||
			movedOwned.branch !== owned.branch ||
			movedOwned.baseSha !== owned.baseSha
		) {
			await restore();
			throw new Error(
				`worktree identity changed while quarantining '${owned.path}'`,
			);
		}
		if (!force && (await this.hasLocalChanges(movedOwned, opts))) {
			await restore();
			throw new Error(
				`worktree changed while quarantining '${owned.path}'; it was preserved`,
			);
		}

		const removed = await git(
			["worktree", "remove", ...(force ? ["--force"] : []), quarantine],
			this.repoRoot,
		);
		if (removed.exitCode !== 0) {
			await restore();
			throw new Error(
				`could not remove quarantined worktree '${owned.path}': ${removed.stderr || removed.stdout}`,
			);
		}
		if (deleteBranch) {
			const deleted = await git(
				["update-ref", "-d", `refs/heads/${owned.branch}`, tip.stdout.trim()],
				this.repoRoot,
			);
			if (deleted.exitCode !== 0) {
				throw new Error(
					`worktree was removed but branch '${owned.branch}' changed and was preserved`,
				);
			}
		}
	}

	/**
	 * Save a run's work to a plain `wip/<task>-<run>` branch before anything
	 * destroys it. The commit captures the worktree as it is: committed work,
	 * staged and unstaged edits and untracked files (ignored files stay out, as
	 * they would for any commit). It is built in a temporary copy of the
	 * worktree's index, so the agent's own index and HEAD are never touched;
	 * the copy keeps the sparse `skip-worktree` bits, so the absent board does
	 * not read as deleted. With no worktree on disk the branch tip is saved.
	 *
	 * Returns null when there is nothing beyond `baseSha` to save. `wip/` refs
	 * are never deleted by MFW: gc only touches `mfw/<runId>`.
	 */
	async archiveWip(
		wt: Worktree,
		name: { runId: string; taskId?: string | null },
	): Promise<WipArchive | null> {
		const present =
			(await this.list()).some(
				(candidate) => resolve(candidate) === resolve(wt.path),
			) &&
			(await access(wt.path).then(
				() => true,
				() => false,
			));
		let sha: string;
		if (present) {
			sha = await this.snapshotWorktree(wt.path, name);
		} else {
			const tip = await git(
				["rev-parse", "--verify", "-q", `refs/heads/${wt.branch}^{commit}`],
				this.repoRoot,
			);
			if (tip.exitCode !== 0) return null;
			sha = tip.stdout.trim();
		}
		if (sha === wt.baseSha) return null;

		const base = `refs/heads/wip/${name.taskId ? `${name.taskId}-` : ""}${name.runId}`;
		for (let n = 1; n <= 20; n++) {
			const ref = n === 1 ? base : `${base}-${n}`;
			// Create-only (empty old value): an earlier archive is never overwritten.
			const created = await git(["update-ref", ref, sha, ""], this.repoRoot);
			if (created.exitCode === 0) {
				return { ref: ref.slice("refs/heads/".length), sha, created: true };
			}
			const existing = await git(
				["rev-parse", "--verify", "-q", ref],
				this.repoRoot,
			);
			if (existing.exitCode === 0 && existing.stdout.trim() === sha) {
				return { ref: ref.slice("refs/heads/".length), sha, created: false };
			}
		}
		throw new Error(`could not create a wip branch for run ${name.runId}`);
	}

	/** Commit the worktree's full state (see `archiveWip`) without moving HEAD. */
	private async snapshotWorktree(
		path: string,
		name: { runId: string; taskId?: string | null },
	): Promise<string> {
		const head = await gitOk(["rev-parse", "HEAD"], path);
		const index = await gitOk(
			["rev-parse", "--path-format=absolute", "--git-path", "index"],
			path,
		);
		const tmp = await mkdtemp(join(tmpdir(), "mfw-wip-"));
		try {
			const env = { GIT_INDEX_FILE: join(tmp, "index") };
			const copied = await copyFile(index, env.GIT_INDEX_FILE).then(
				() => true,
				() => false,
			);
			if (!copied) await gitOk(["read-tree", "HEAD"], path, { env });
			await gitOk(["add", "-A"], path, { env });
			const tree = await gitOk(["write-tree"], path, { env });
			if (tree === (await gitOk(["rev-parse", "HEAD^{tree}"], path))) {
				return head;
			}
			return await gitOk(
				[
					"-c",
					"user.name=mfw",
					"-c",
					"user.email=mfw@localhost",
					"commit-tree",
					tree,
					"-p",
					head,
					"-m",
					`mfw wip: run ${name.runId}${name.taskId ? ` (${name.taskId})` : ""}`,
				],
				path,
			);
		} finally {
			await rm(tmp, { recursive: true, force: true });
		}
	}

	/**
	 * Throw away a run's worktree and `mfw/` branch, after saving them with
	 * `archiveWip`. The caller proves the run is not live (this class does not
	 * know runs). An unproven worktree is refused like `remove`.
	 */
	async discard(
		wt: Worktree,
		name: { runId: string; taskId?: string | null },
	): Promise<{ archive: WipArchive | null; removed: boolean }> {
		const archive = await this.archiveWip(wt, name);
		const registered = (await this.list()).some(
			(candidate) => resolve(candidate) === resolve(wt.path),
		);
		if (registered) {
			await this.remove(wt, { force: true, deleteBranch: true });
			return { archive, removed: true };
		}
		// No worktree: only the branch is left. Compare-and-delete the exact tip
		// that was archived, so a concurrently advanced branch survives.
		const tip = await git(
			["rev-parse", "--verify", "-q", `refs/heads/${wt.branch}`],
			this.repoRoot,
		);
		if (tip.exitCode === 0 && wt.branch.startsWith("mfw/")) {
			const expected = tip.stdout.trim();
			if (archive && archive.sha !== expected) {
				throw new Error(
					`branch '${wt.branch}' moved while it was archived; it was preserved`,
				);
			}
			await gitOk(
				["update-ref", "-d", `refs/heads/${wt.branch}`, expected],
				this.repoRoot,
			);
		}
		return { archive, removed: false };
	}

	private async markerAt(path: string): Promise<OwnedWorktree | null> {
		const registered = (await this.list()).some(
			(candidate) => resolve(candidate) === resolve(path),
		);
		if (!registered) return null;
		const read = async (key: string) =>
			git(["config", "--worktree", "--get", key], path);
		const [runId, markedBranch, baseSha, branch] = await Promise.all([
			read(OWNER_RUN_ID),
			read(OWNER_BRANCH),
			read(OWNER_BASE_SHA),
			git(["symbolic-ref", "--short", "HEAD"], path),
		]);
		if (
			runId.exitCode !== 0 ||
			markedBranch.exitCode !== 0 ||
			baseSha.exitCode !== 0 ||
			branch.exitCode !== 0
		) {
			return null;
		}
		const identity = {
			runId: runId.stdout.trim(),
			branch: markedBranch.stdout.trim(),
			baseSha: baseSha.stdout.trim(),
		};
		if (!identity.runId || !identity.baseSha) return null;
		if (identity.branch !== `mfw/${identity.runId}`) return null;
		if (branch.stdout.trim() !== identity.branch) return null;
		return { path: resolve(path), ...identity };
	}

	/** Paths of worktrees git currently tracks (excluding the main worktree). */
	async list(): Promise<string[]> {
		const r = await git(["worktree", "list", "--porcelain"], this.repoRoot);
		const paths: string[] = [];
		for (const line of r.stdout.split("\n")) {
			if (line.startsWith("worktree ")) {
				const p = line.slice("worktree ".length);
				if (p !== this.repoRoot) paths.push(p);
			}
		}
		return paths;
	}
}
