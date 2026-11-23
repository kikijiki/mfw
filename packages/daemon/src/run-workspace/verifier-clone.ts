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
 */
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CheckRunner } from "../containment/check-runner.ts";
import { git } from "../git.ts";
import { assertRunId } from "../host-git/fetch.ts";
import type { HostGit } from "../host-git/runner.ts";
import type { CacheDeclaration } from "./caches.ts";
import { seedWorkspace } from "./seed.ts";

const ID_PREFIX = "verify-";
const REF_PREFIX = "refs/mfw/verify/";

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
		const pin = await git(["update-ref", ref, sha], this.opts.primaryRoot);
		if (pin.exitCode !== 0) {
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
			await git(["update-ref", "-d", ref], this.opts.primaryRoot);
			throw e;
		}
		// Beside `tree/` and `git/`, never bound: what marks this as a host-owned
		// clone to the sandbox builders.
		await writeFile(
			join(seeded.dir, "mfw-workspace.json"),
			`${JSON.stringify({ version: 1, runId: id, role: "verifier", baseSha: sha })}\n`,
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
				await rm(seeded.dir, { recursive: true, force: true });
				await git(["update-ref", "-d", ref], this.opts.primaryRoot);
			},
		};
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
	 * Remove clones and pins a crashed daemon left behind. Call it at startup,
	 * when no verification can be running.
	 */
	async sweep(): Promise<number> {
		let removed = 0;
		for (const id of await readdir(this.root).catch(() => [] as string[])) {
			if (!isVerifierCloneId(id)) continue;
			await rm(join(this.root, id), { recursive: true, force: true });
			removed++;
		}
		const refs = await git(
			["for-each-ref", "--format=%(refname)", REF_PREFIX],
			this.opts.primaryRoot,
		);
		for (const ref of refs.stdout.split("\n").filter(Boolean)) {
			await git(["update-ref", "-d", ref], this.opts.primaryRoot);
		}
		return removed;
	}
}
