/**
 * Disposable, host-owned clones for verification (backstage architecture.md,
 * "Run workspace").
 *
 * A DoD check runs the candidate's own code, so it must not run in the run's
 * workspace (agent-writable, possibly tampered) nor in the host's integration
 * worktree. Instead the host seeds a fresh clone of exactly the commit to
 * verify (a run's quarantine tip, or the merge commit the queue is about to
 * land) from the trusted primary, runs the checks there, and throws it away.
 *
 * The clone lives under the workspace root like any agent-writable tree, so
 * HostGit refuses to run git in it: nothing in the daemon inspects the clone
 * with git. What the verifier used to ask git (`status`, `rev-parse HEAD`) is
 * answered from the commit sha the host already knows.
 *
 * Each clone pins its commit with `refs/mfw/verify/<id>` in the primary while
 * it exists, so an unreferenced merge commit survives the seed and a crash
 * leaves a ref `sweep` can find.
 *
 * The workspace root is shared by every project of a daemon (and by a second
 * daemon), so `sweep` removes only clones it can show are orphaned: the
 * clone's `mfw-workspace.json` names its owner (this process's instance id
 * and pid), and a clone is spared while this process is still using it or its
 * owner process is alive, unless it is older than `orphanAgeMs`.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CheckRunner } from "../containment/check-runner.ts";
import { git } from "../git.ts";
import { assertRunId } from "../host-git/fetch.ts";
import type { HostGit } from "../host-git/runner.ts";
import type { CacheDeclaration } from "./caches.ts";
import { removeTree } from "./remove-tree.ts";
import { seedWorkspace } from "./seed.ts";

const ID_PREFIX = "verify-";
const REF_PREFIX = "refs/mfw/verify/";

/** A verification that has run longer than this is not a verification. */
const DEFAULT_ORPHAN_AGE_MS = 24 * 60 * 60_000;
/** A clone with no owner record yet may be mid-seed in another process. */
const UNMARKED_GRACE_MS = 10 * 60_000;

/** Names this process's lifetime; a restarted daemon is a different instance. */
const INSTANCE = crypto.randomUUID();
/** Clone ids this process is creating or using, across every `VerifierClones`. */
const LIVE = new Set<string>();

interface CloneOwner {
	instance: string;
	pid: number;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		// EPERM: it exists, we just may not signal it.
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function ageMs(path: string, createdAt: unknown): Promise<number> {
	const made = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
	if (Number.isFinite(made)) return Date.now() - made;
	return Date.now() - (await stat(path)).mtimeMs;
}

export interface VerifierCloneOptions {
	/** `$MFW_HOME/workspaces`: the same root as the run clones. */
	workspaceRoot: string;
	/** The trusted primary checkout. */
	primaryRoot: string;
	/** Caches carried into the clone, as for a run (none by default). */
	caches?: CacheDeclaration[];
	gitBin?: string;
	host?: HostGit;
	log?: (msg: string) => void;
	/** Runs a check in the verifier sandbox. Without it, checks are refused. */
	checkRunner?: CheckRunner;
	/**
	 * How old a clone owned by another live process must be before `sweep`
	 * treats it as abandoned. Default 24 hours.
	 */
	orphanAgeMs?: number;
}

/** One verification clone: check it out of `path`, then `dispose` it. */
export interface VerifierClone {
	id: string;
	/** The work tree the checks run in. */
	path: string;
	/** The commit it holds, a full object id. */
	sha: string;
	dispose(): Promise<void>;
}

function cleanLabel(label: string): string {
	return label.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40) || "x";
}

/** True for the id of a verifier clone directory. */
export function isVerifierCloneId(id: string): boolean {
	return id.startsWith(ID_PREFIX);
}

export class VerifierClones {
	private readonly root: string;
	/** Null means no check may run: the host never runs a candidate's code. */
	readonly checkRunner: CheckRunner | null;

	constructor(private readonly opts: VerifierCloneOptions) {
		this.root = resolve(opts.workspaceRoot);
		this.checkRunner = opts.checkRunner ?? null;
	}

	/** Seed a clone of `rev` (a commit in the primary, or a ref that names one). */
	async create(rev: string, label: string): Promise<VerifierClone> {
		const resolved = await git(
			["rev-parse", "--verify", "-q", `${rev}^{commit}`],
			this.opts.primaryRoot,
		);
		if (resolved.exitCode !== 0) {
			throw new Error(`cannot verify ${rev}: no such commit in the primary`);
		}
		const sha = resolved.stdout;
		const id = `${ID_PREFIX}${cleanLabel(label)}-${crypto.randomUUID().slice(0, 8)}`;
		assertRunId(id);
		const ref = `${REF_PREFIX}${id}`;
		// Live from before the pin: a sweep elsewhere must not see a half-made clone.
		LIVE.add(id);
		const pin = await git(["update-ref", ref, sha], this.opts.primaryRoot);
		if (pin.exitCode !== 0) {
			LIVE.delete(id);
			throw new Error(`could not pin ${sha} for verification: ${pin.stderr}`);
		}
		let seeded: Awaited<ReturnType<typeof seedWorkspace>>;
		try {
			await mkdir(this.root, { recursive: true, mode: 0o700 });
			seeded = await seedWorkspace({
				runId: id,
				workspaceRoot: this.root,
				primaryRoot: this.opts.primaryRoot,
				baseSha: sha,
				// A check needs the commit, not the project's history.
				history: "tip",
				...(this.opts.caches ? { caches: this.opts.caches } : {}),
				...(this.opts.gitBin ? { gitBin: this.opts.gitBin } : {}),
				...(this.opts.host ? { host: this.opts.host } : {}),
				...(this.opts.log ? { log: this.opts.log } : {}),
			});
		} catch (e) {
			LIVE.delete(id);
			await git(["update-ref", "-d", ref], this.opts.primaryRoot);
			throw e;
		}
		// Beside `tree/` and `git/`, never bound: what marks this as a host-owned
		// clone to the sandbox builders.
		await writeFile(
			join(seeded.dir, "mfw-workspace.json"),
			`${JSON.stringify({
				version: 1,
				runId: id,
				role: "verifier",
				baseSha: sha,
				owner: { instance: INSTANCE, pid: process.pid } satisfies CloneOwner,
				createdAt: new Date().toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		let disposed = false;
		return {
			id,
			path: seeded.treeDir,
			sha,
			dispose: async () => {
				if (disposed) return;
				disposed = true;
				const left = await removeTree(seeded.dir);
				if (left.length === 0) LIVE.delete(id);
				// Whatever the check did to the tree, the pin never outlives it.
				await git(["update-ref", "-d", ref], this.opts.primaryRoot);
				if (left.length > 0) {
					throw new Error(`could not remove ${left.slice(0, 3).join(", ")}`);
				}
			},
		};
	}

	/** Whether the commit itself has this path. Asks the trusted primary. */
	async fileInCommit(sha: string, path: string): Promise<boolean> {
		const r = await git(
			["cat-file", "-e", `${sha}:${path}`],
			this.opts.primaryRoot,
		);
		return r.exitCode === 0;
	}

	/** Run `fn` against a fresh clone of `rev`, and dispose it however `fn` ends. */
	async with<T>(
		rev: string,
		label: string,
		fn: (clone: VerifierClone) => Promise<T>,
	): Promise<T> {
		const clone = await this.create(rev, label);
		try {
			return await fn(clone);
		} finally {
			await clone.dispose().catch((e) => {
				this.opts.log?.(`verifier clone ${clone.id} not removed: ${e}`);
			});
		}
	}

	/**
	 * Remove clones and pins a crashed daemon left behind. Safe at any time:
	 * a clone this process is using, one a live process owns, and one too new
	 * to have an owner record are all left alone. Never touches another
	 * project's in-flight verification.
	 */
	async sweep(): Promise<number> {
		let removed = 0;
		const gone = new Set<string>();
		for (const id of await readdir(this.root).catch(() => [] as string[])) {
			if (!isVerifierCloneId(id)) continue;
			const dir = join(this.root, id);
			if (!(await this.orphaned(id, dir))) continue;
			// One clone that cannot be removed must not stop the others or the refs.
			const left = await removeTree(dir);
			if (left.length === 0) {
				removed++;
				gone.add(id);
				LIVE.delete(id);
			} else this.opts.log?.(`verifier clone ${id} not removed: ${left[0]}`);
		}
		const refs = await git(
			["for-each-ref", "--format=%(refname)", REF_PREFIX],
			this.opts.primaryRoot,
		);
		for (const ref of refs.stdout.split("\n").filter(Boolean)) {
			const id = ref.slice(REF_PREFIX.length);
			// A pin whose clone still exists belongs to it; one with no clone is
			// stale unless this process is still making it.
			if (LIVE.has(id)) continue;
			const dir = join(this.root, id);
			const present = await stat(dir).then(
				() => true,
				() => false,
			);
			if (present && !gone.has(id)) continue;
			await git(["update-ref", "-d", ref], this.opts.primaryRoot);
		}
		return removed;
	}

	/** Whether `dir` is provably abandoned rather than someone's live clone. */
	private async orphaned(id: string, dir: string): Promise<boolean> {
		let meta: { owner?: Partial<CloneOwner>; createdAt?: unknown } | null =
			null;
		try {
			meta = JSON.parse(
				await readFile(join(dir, "mfw-workspace.json"), "utf8"),
			);
		} catch {}
		const owner = meta?.owner;
		if (owner?.instance === INSTANCE) return !LIVE.has(id);
		if (!owner || typeof owner.pid !== "number") {
			// Mid-seed here or in another process, or damaged: only a stale one goes.
			if (LIVE.has(id)) return false;
			return (await ageMs(dir, meta?.createdAt)) >= UNMARKED_GRACE_MS;
		}
		if (!pidAlive(owner.pid)) return true;
		return (
			(await ageMs(dir, meta?.createdAt)) >=
			(this.opts.orphanAgeMs ?? DEFAULT_ORPHAN_AGE_MS)
		);
	}
}
