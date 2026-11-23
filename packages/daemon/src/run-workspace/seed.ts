/**
 * Seeding a run workspace: `$MFW_HOME/workspaces/<runId>/{git,tree}`.
 *
 * The workspace is a private clone of the trusted primary, made on the host
 * before any agent code exists in it:
 *
 *  - `git/` is the clone's gitdir and `tree/` its work tree. The gitdir is a
 *    sibling, not `tree/.git`, so nothing that walks up from the tree (an IDE,
 *    a shell prompt, the owner's agents) discovers a repository. The sandbox
 *    binds both in and sets `GIT_DIR` and `GIT_WORK_TREE`.
 *  - Objects arrive as a new pack of only what the commit reaches, so no other
 *    branch, quarantined run or unreachable object is readable from the clone.
 *    There are no alternates: a clone with `objects/info/alternates` is refused.
 *  - Nothing else of the primary's gitdir is taken: not its config, hooks,
 *    refs, remotes or worktree list. The gitdir is rebuilt with a minimal
 *    config, the base commit pinned at `refs/mfw/base/<runId>`, and the run
 *    branch `mfw/<runId>` (the ref a fetch reads back) at the base.
 *  - The tree is a host checkout of that commit, under the HostGit environment
 *    (no global config, no hooks, no fsmonitor). Tracked content only: no
 *    `.env`, no ignored or untracked files. Declared caches are added after.
 *
 * Workspaces are always under the workspace root, mode 0700, never inside the
 * primary checkout.
 */
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { assertRunId } from "../host-git/fetch.ts";
import { HostGit } from "../host-git/runner.ts";
import { runProc } from "../proc.ts";
import {
	type CacheDeclaration,
	type CacheOutcome,
	seedCaches,
} from "./caches.ts";

export type SeedStrategy = "pack";

export type SeedErrorCode =
	| "bad_argument"
	| "workspace_exists"
	| "primary_unusable"
	| "alternates"
	| "base_missing"
	| "seed_failed";

export class SeedError extends Error {
	constructor(
		readonly code: SeedErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SeedError";
	}
}

export interface SeedOptions {
	runId: string;
	/** `$MFW_HOME/workspaces`. Created at mode 0700 when missing. */
	workspaceRoot: string;
	/** The trusted primary checkout (or a linked worktree of it). */
	primaryRoot: string;
	/** The commit the run starts from: a full object id. */
	baseSha: string;
	/** Caches to carry over; none by default (tracked content only). */
	caches?: CacheDeclaration[];
	/**
	 * `full` (the default) keeps the commit's history, for a run that works on
	 * it. `tip` holds the commit and its tree alone, for a role that only reads
	 * or checks it, so deleted history cannot be read or sent anywhere.
	 */
	history?: "full" | "tip";
	/** An absolute path to git; resolved from PATH when omitted. */
	gitBin?: string;
	/** Injected for tests; default one rooted at `workspaceRoot`. */
	host?: HostGit;
	log?: (msg: string) => void;
}

export interface SeedResult {
	runId: string;
	/** `<workspaceRoot>/<runId>`. */
	dir: string;
	gitDir: string;
	treeDir: string;
	strategy: SeedStrategy;
	/** What the store holds: `reachable` from the commit, or the `tip` alone. */
	strategyReason: string;
	baseRef: string;
	branchRef: string;
	caches: CacheOutcome[];
}

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_TIMEOUT_MS = 120_000;
const CHECKOUT_TIMEOUT_MS = 10 * 60_000;

export const baseRefName = (runId: string): string => {
	assertRunId(runId);
	return `refs/mfw/base/${runId}`;
};
export const branchRefName = (runId: string): string => {
	assertRunId(runId);
	return `refs/heads/mfw/${runId}`;
};

async function exists(p: string): Promise<boolean> {
	try {
		await lstat(p);
		return true;
	} catch {
		return false;
	}
}

/** The minimal clone config: no remote, no hooks, no identity, nothing that runs a program. */
export function cloneConfig(sha256: boolean): string {
	return [
		"[core]",
		`\trepositoryformatversion = ${sha256 ? 1 : 0}`,
		"\tfilemode = true",
		"\tbare = false",
		"\tlogallrefupdates = false",
		...(sha256 ? ["[extensions]", "\tobjectformat = sha256"] : []),
		"",
	].join("\n");
}

class Seeder {
	private readonly host: HostGit;
	private readonly gitBin: string;
	private readonly log: (msg: string) => void;

	constructor(private readonly opts: SeedOptions) {
		this.log = opts.log ?? (() => {});
		this.host =
			opts.host ??
			new HostGit({
				workspaceRoot: opts.workspaceRoot,
				ownedRoots: [opts.primaryRoot],
			});
		const bin = opts.gitBin ?? Bun.which("git");
		if (!bin || !isAbsolute(bin)) {
			throw new SeedError("bad_argument", "cannot resolve git");
		}
		this.gitBin = bin;
	}

	/** Host git over the trusted primary or the fresh clone, under the HostGit env and `-c` prelude. */
	async git(
		args: string[],
		cwd: string,
		timeoutMs = GIT_TIMEOUT_MS,
	): Promise<string> {
		const r = await runProc(
			[this.gitBin, ...this.host.configArgs({ allowFile: true }), ...args],
			{ cwd, env: this.host.env(), timeoutMs, hostGitChecked: true },
		);
		if (r.exitCode !== 0) {
			throw new SeedError(
				"seed_failed",
				`git ${args.slice(0, 3).join(" ")} failed (${r.exitCode}): ${(r.stderr || r.stdout).trim()}`,
			);
		}
		return r.stdout.trim();
	}

	async hasAlternates(gitDir: string): Promise<boolean> {
		for (const f of ["alternates", "http-alternates"]) {
			if (await exists(join(gitDir, "objects", "info", f))) return true;
		}
		return false;
	}

	/** The object store of the primary: its common dir, so a linked worktree works too. */
	async primaryObjectsOwner(): Promise<string> {
		let common: string;
		try {
			common = await this.git(
				["rev-parse", "--path-format=absolute", "--git-common-dir"],
				this.opts.primaryRoot,
			);
		} catch (e) {
			throw new SeedError(
				"primary_unusable",
				`${this.opts.primaryRoot} is not a git repository: ${(e as Error).message}`,
			);
		}
		return common;
	}

	/**
	 * A new object store holding only what the commit reaches: never a copy of
	 * the primary's, which also holds other branches, quarantined work and
	 * whatever history dropped. With `history: "tip"`, only the commit's own tree.
	 */
	async seedObjects(
		primaryGit: string,
		gitDir: string,
	): Promise<{ strategy: SeedStrategy; reason: string }> {
		const { baseSha } = this.opts;
		const tipOnly = this.opts.history === "tip";
		await this.git(
			[
				"init",
				"--bare",
				"--quiet",
				"--template=",
				`--object-format=${baseSha.length === 64 ? "sha256" : "sha1"}`,
				gitDir,
			],
			this.opts.workspaceRoot,
		);
		const prefix = [this.gitBin, ...this.host.configArgs({ allowFile: true })];
		const env = this.host.env();
		const list = Bun.spawn(
			[
				...prefix,
				`--git-dir=${primaryGit}`,
				"rev-list",
				"--objects",
				...(tipOnly ? ["--no-walk"] : []),
				baseSha,
			],
			{ cwd: this.opts.workspaceRoot, env, stdout: "pipe", stderr: "pipe" },
		);
		const pack = Bun.spawn(
			[
				...prefix,
				`--git-dir=${primaryGit}`,
				"pack-objects",
				"--stdout",
				"--quiet",
			],
			{
				cwd: this.opts.workspaceRoot,
				env,
				stdin: list.stdout,
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const index = Bun.spawn(
			[...prefix, `--git-dir=${gitDir}`, "index-pack", "--stdin"],
			{
				cwd: this.opts.workspaceRoot,
				env,
				stdin: pack.stdout,
				stdout: "ignore",
				stderr: "pipe",
			},
		);
		const procs = [list, pack, index];
		const timer = setTimeout(() => {
			for (const p of procs) p.kill("SIGKILL");
		}, CHECKOUT_TIMEOUT_MS);
		try {
			const [codes, errors] = await Promise.all([
				Promise.all(procs.map((p) => p.exited)),
				Promise.all(procs.map((p) => new Response(p.stderr).text())),
			]);
			if (codes.some((c) => c !== 0)) {
				throw new SeedError(
					"seed_failed",
					`packing the commit's objects failed (${codes.join(",")}): ${errors.join(" ").trim().slice(0, 500)}`,
				);
			}
		} finally {
			clearTimeout(timer);
		}
		return { strategy: "pack", reason: tipOnly ? "tip" : "reachable" };
	}

	/** Drop everything the copy brought but the object store (and a shallow file), and write a minimal skeleton. */
	async rebuildGitDir(gitDir: string, runId: string): Promise<void> {
		for (const e of await readdir(gitDir)) {
			if (e === "objects" || e === "shallow") continue;
			await rm(join(gitDir, e), { recursive: true, force: true });
		}
		// objects/info holds the alternates, commit-graph and the like; keep only packs and loose objects.
		await rm(join(gitDir, "objects", "info"), {
			recursive: true,
			force: true,
		});
		await mkdir(join(gitDir, "objects", "info"));
		for (const d of ["refs/heads", "refs/tags", "refs/mfw"]) {
			await mkdir(join(gitDir, d), { recursive: true });
		}
		await writeFile(join(gitDir, "HEAD"), `ref: ${branchRefName(runId)}\n`);
		const sha256 = OBJECT_ID.test(this.opts.baseSha)
			? this.opts.baseSha.length === 64
			: false;
		await writeFile(join(gitDir, "config"), cloneConfig(sha256));
	}

	async run(): Promise<SeedResult> {
		const { runId, baseSha } = this.opts;
		assertRunId(runId);
		if (!isAbsolute(this.opts.workspaceRoot)) {
			throw new SeedError("bad_argument", "workspaceRoot must be absolute");
		}
		if (!isAbsolute(this.opts.primaryRoot)) {
			throw new SeedError("bad_argument", "primaryRoot must be absolute");
		}
		if (!OBJECT_ID.test(baseSha)) {
			throw new SeedError(
				"bad_argument",
				`baseSha must be a full object id: ${JSON.stringify(baseSha)}`,
			);
		}
		const root = resolve(this.opts.workspaceRoot);
		const primary = await realpath(this.opts.primaryRoot).catch(() => {
			throw new SeedError(
				"primary_unusable",
				`primary ${this.opts.primaryRoot} does not exist`,
			);
		});
		const realRoot = (await realpath(root).catch(() => root)) + sep;
		if (realRoot.startsWith(primary + sep) || primary.startsWith(realRoot)) {
			throw new SeedError(
				"bad_argument",
				"the workspace root and the primary checkout must not contain each other",
			);
		}

		// Everything fallible before creating the workspace.
		const primaryGit = await this.primaryObjectsOwner();
		if (await this.hasAlternates(primaryGit)) {
			throw new SeedError(
				"alternates",
				"the primary repository uses alternates; run workspaces cannot be seeded from it (repack with `git repack -a -d` and remove objects/info/alternates)",
			);
		}
		try {
			await this.git(
				["cat-file", "-e", `${baseSha}^{commit}`],
				this.opts.primaryRoot,
			);
		} catch {
			throw new SeedError(
				"base_missing",
				`commit ${baseSha} is not in the primary repository`,
			);
		}

		await mkdir(root, { recursive: true, mode: 0o700 });
		const dir = join(root, runId);
		try {
			await mkdir(dir, { mode: 0o700 });
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST") {
				throw new SeedError("workspace_exists", `${dir} already exists`);
			}
			throw e;
		}
		try {
			return await this.populate(dir, primaryGit, primary);
		} catch (e) {
			await rm(dir, { recursive: true, force: true });
			throw e;
		}
	}

	private async populate(
		dir: string,
		primaryGit: string,
		primary: string,
	): Promise<SeedResult> {
		const { runId, baseSha } = this.opts;
		await chmod(dir, 0o700);
		const gitDir = join(dir, "git");
		const treeDir = join(dir, "tree");

		const picked = await this.seedObjects(primaryGit, gitDir);
		this.log(`seed ${runId}: strategy ${picked.strategy} (${picked.reason})`);
		await this.rebuildGitDir(gitDir, runId);
		// The commit's parents are absent on purpose: tell git it is a boundary.
		if (this.opts.history === "tip") {
			await writeFile(join(gitDir, "shallow"), `${baseSha}\n`);
		}
		await chmod(gitDir, 0o700);
		if (await this.hasAlternates(gitDir)) {
			throw new SeedError("alternates", "the seeded gitdir has alternates");
		}

		const baseRef = baseRefName(runId);
		const branchRef = branchRefName(runId);
		const gd = `--git-dir=${gitDir}`;
		await this.git([gd, "update-ref", baseRef, baseSha], dir);
		await this.git([gd, "update-ref", branchRef, baseSha], dir);

		await mkdir(treeDir, { mode: 0o700 });
		await chmod(treeDir, 0o700);
		// Host checkout of a commit just copied from the trusted primary: the
		// gitdir has no config but ours and no hooks, and the env has no global one.
		await this.git(
			[gd, `--work-tree=${treeDir}`, "read-tree", "-u", "--reset", "HEAD"],
			treeDir,
			CHECKOUT_TIMEOUT_MS,
		);
		if (await exists(join(treeDir, ".git"))) {
			throw new SeedError("seed_failed", "the seeded tree has a .git entry");
		}

		const caches = await seedCaches({
			primaryRoot: primary,
			treeRoot: treeDir,
			declarations: this.opts.caches ?? [],
			log: this.log,
		});
		return {
			runId,
			dir,
			gitDir,
			treeDir,
			strategy: picked.strategy,
			strategyReason: picked.reason,
			baseRef,
			branchRef,
			caches,
		};
	}
}

/** Seed `<workspaceRoot>/<runId>/{git,tree}` from the primary at `baseSha`. Removes what it made on failure. */
export async function seedWorkspace(opts: SeedOptions): Promise<SeedResult> {
	return new Seeder(opts).run();
}
