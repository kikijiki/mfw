import { randomBytes } from "node:crypto";
import {
	appendFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { readSmallRegularFile } from "../containment/safe-file.ts";
import { git } from "../git.ts";
import {
	assertRunId,
	type FetchValidationContext,
	fetchRunResult,
	quarantineRef,
	quarantineWipPrefix,
} from "../host-git/fetch.ts";
import { HostGit, HostGitError } from "../host-git/runner.ts";
import type { CacheDeclaration } from "./caches.ts";
import type {
	OwnedRunWorkspace,
	RunWorkspace,
	RunWorkspaceHandle,
	RunWorkspacePaths,
	RunWorkspaceResult,
	WipArchive,
	WorkspaceContentOptions,
	WorkspaceName,
	WorktreeReportIdentity,
} from "./run-workspace.ts";
import { seedWorkspace } from "./seed.ts";
import { type WipAck, wipAckFile, wipControlLine } from "./wip-helper.ts";

/**
 * `RunWorkspace` over a private clone per run (backstage architecture.md,
 * "Run workspace"): `<workspaceRoot>/<runId>/{git,tree,outbox}`.
 *
 * The clone is agent-writable, so the host never runs git on it. The host
 * owns exactly two things here:
 *
 *  - the seed (`seed.ts`: reflink or clone of the objects, minimal config,
 *    host checkout), made before any agent code exists, and
 *  - the import of the result: the in-sandbox helper writes a bundle to
 *    `outbox/result.bundle`, and `fetchRunResult` verifies it in a throwaway
 *    bare repo and fetches it into the primary's quarantine refs. Every
 *    primary-side read (the quarantine tip, the `wip/` archive) happens in the
 *    trusted primary, never in the clone.
 *
 * A host-only marker `<runId>/mfw-workspace.json` records ownership. It sits
 * beside `git/`, `tree/` and `outbox/`, which are the only things the sandbox
 * binds in, so the agent cannot rewrite it.
 */

const MARKER = "mfw-workspace.json";
const BUNDLE_REL = "outbox/result.bundle";

interface Marker {
	version: 1;
	runId: string;
	primaryRoot: string;
	baseSha: string;
	branch: string;
	createdAt: string;
	/** Set once the host imported the result; the quarantine refs are then the record of the work. */
	importedTip?: string;
}

export interface CloneWorkspaceOptions {
	/** `$MFW_HOME/workspaces`. */
	workspaceRoot: string;
	/** Host-owned dir for throwaway bare repos, outside `workspaceRoot`. Default: a sibling of it. */
	scratchRoot?: string;
	/** The runner for everything that touches agent-writable data. Default: one over `workspaceRoot` and `scratchRoot`. */
	host?: HostGit;
	/**
	 * Proves the run's processes are dead before its bundle is read. Without
	 * it nothing is imported: `fetchResult` only reports an earlier import.
	 */
	assertProcessesDead?: (runId: string) => void | Promise<void>;
	/** Runs on the fetched, still-untrusted refs. Default: `validateRunResult`. */
	validate?: (
		ctx: FetchValidationContext,
		baseSha: string,
	) => void | Promise<void>;
	/**
	 * Where the run's `control.jsonl` lives. Needed by `requestWip`, which asks
	 * the in-sandbox helper (`wip-helper.ts`) for a snapshot through it.
	 */
	controlPath?: (runId: string) => string;
	/**
	 * Proves a *live* run is quiescent (for example its cgroup is frozen), so a
	 * snapshot bundle can be imported before the run ends. Without it
	 * `requestWip` returns the helper's ack and imports nothing; the bundle is
	 * then imported by `fetchResult` once `assertProcessesDead` passes.
	 */
	assertQuiescent?: (runId: string) => void | Promise<void>;
	/** Caches carried into the clone; none by default. */
	caches?: CacheDeclaration[];
	gitBin?: string;
	log?: (msg: string) => void;
}

const MODE_GITLINK = "160000";
const MODE_SYMLINK = "120000";
const PROTECTED_NAMES = new Set([
	".gitmodules",
	".gitattributes",
	".lfsconfig",
]);

/**
 * The default bounds on a fetched result, checked in the bare repo with no
 * checkout. A run may not touch `.gitmodules`, `.gitattributes` or
 * `.lfsconfig` (each makes git run or fetch something), add a gitlink, or add
 * a symlink that leaves the tree. A run that needs one is refused, not
 * silently altered.
 */
export async function validateRunResult(
	ctx: FetchValidationContext,
	baseSha: string,
): Promise<void> {
	for (const ref of [ctx.headRef, ...ctx.wipRefs]) {
		const raw = await ctx.host.runOk(
			["diff-tree", "-r", "-z", "--raw", "--no-renames", baseSha, ref],
			{ cwd: ctx.bareRepo, repo: ctx.bareRepo },
		);
		const parts = raw.split("\0");
		for (let i = 0; i + 1 < parts.length; i += 2) {
			const meta = (parts[i] ?? "").split(" ");
			const path = parts[i + 1] ?? "";
			const newMode = meta[1] ?? "";
			const newSha = meta[3] ?? "";
			const status = (meta[4] ?? "").slice(0, 1);
			if (PROTECTED_NAMES.has(basename(path))) {
				throw new HostGitError(
					"validation",
					`the run changed ${JSON.stringify(path.slice(0, 120))}, which an imported result may not`,
				);
			}
			if (status === "D") continue;
			if (newMode === MODE_GITLINK) {
				throw new HostGitError(
					"validation",
					`the run added a gitlink at ${JSON.stringify(path.slice(0, 120))}`,
				);
			}
			if (newMode === MODE_SYMLINK) {
				const target = await ctx.host.runOk(["cat-file", "-p", newSha], {
					cwd: ctx.bareRepo,
					repo: ctx.bareRepo,
				});
				if (symlinkEscapes(path, target.trimEnd())) {
					throw new HostGitError(
						"validation",
						`the run added a symlink that leaves the tree: ${JSON.stringify(path.slice(0, 120))}`,
					);
				}
			}
		}
	}
}

/** True when a symlink at `path` pointing to `target` resolves outside the tree. */
function symlinkEscapes(path: string, target: string): boolean {
	if (target.startsWith("/")) return true;
	const stack = dirname(path) === "." ? [] : dirname(path).split("/");
	for (const part of target.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (stack.pop() === undefined) return true;
		} else {
			stack.push(part);
		}
	}
	return false;
}

/** The helper's ack for request `id`, or null while there is none (or it is for another request). */
async function readAck(path: string, id: string): Promise<WipAck | null> {
	const text = await readSmallRegularFile(path).catch(() => null);
	if (!text) return null;
	try {
		const v = JSON.parse(text) as Partial<WipAck>;
		if (v.id !== id || typeof v.ok !== "boolean") return null;
		return {
			id,
			ok: v.ok,
			...(typeof v.n === "number" ? { n: v.n } : {}),
			...(typeof v.sha === "string" ? { sha: v.sha.slice(0, 64) } : {}),
			...(typeof v.error === "string" ? { error: v.error.slice(0, 500) } : {}),
		};
	} catch {
		return null;
	}
}

export class CloneRunWorkspace implements RunWorkspace {
	readonly kind = "clone";
	private readonly root: string;
	private readonly host: HostGit;
	private readonly scratch: string;

	constructor(
		private readonly primaryRoot: string,
		private readonly opts: CloneWorkspaceOptions,
	) {
		this.root = resolve(opts.workspaceRoot);
		this.scratch = resolve(
			opts.scratchRoot ?? join(dirname(this.root), "workspace-scratch"),
		);
		this.host =
			opts.host ??
			new HostGit({
				workspaceRoot: this.root,
				ownedRoots: [this.scratch],
				...(opts.gitBin ? { gitBin: opts.gitBin } : {}),
			});
	}

	private dirOf(runId: string): string {
		assertRunId(runId);
		return join(this.root, runId);
	}

	/** The run id a workspace tree path belongs to, or throws: only `<root>/<id>/tree` is ours. */
	private runIdOf(path: string): string {
		const p = resolve(path);
		const dir = dirname(p);
		if (basename(p) !== "tree" || dirname(dir) !== this.root) {
			throw new Error(`not a run workspace path: ${path}`);
		}
		const runId = basename(dir);
		assertRunId(runId);
		return runId;
	}

	private async readMarker(runId: string): Promise<Marker | null> {
		try {
			const m = JSON.parse(
				await readFile(join(this.dirOf(runId), MARKER), "utf8"),
			) as Partial<Marker>;
			if (
				m.version !== 1 ||
				m.runId !== runId ||
				m.primaryRoot !== this.primaryRoot ||
				m.branch !== `mfw/${runId}` ||
				typeof m.baseSha !== "string"
			) {
				return null;
			}
			return m as Marker;
		} catch {
			return null;
		}
	}

	private async writeMarker(m: Marker): Promise<void> {
		await writeFile(join(this.dirOf(m.runId), MARKER), JSON.stringify(m), {
			mode: 0o600,
		});
	}

	async seed(runId: string, base?: string): Promise<RunWorkspaceHandle> {
		const dir = this.dirOf(runId);
		const resolved = await git(
			["rev-parse", "--verify", "-q", `${base ?? "HEAD"}^{commit}`],
			this.primaryRoot,
		);
		if (resolved.exitCode !== 0) {
			throw new Error(`cannot resolve base ${base ?? "HEAD"} in the primary`);
		}
		const baseSha = resolved.stdout.trim();
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const seeded = await seedWorkspace({
			runId,
			workspaceRoot: this.root,
			primaryRoot: this.primaryRoot,
			baseSha,
			host: this.host,
			...(this.opts.caches ? { caches: this.opts.caches } : {}),
			...(this.opts.gitBin ? { gitBin: this.opts.gitBin } : {}),
			...(this.opts.log ? { log: this.opts.log } : {}),
		});
		try {
			await mkdir(join(dir, "outbox"), { mode: 0o700 });
			await this.writeMarker({
				version: 1,
				runId,
				primaryRoot: this.primaryRoot,
				baseSha,
				branch: `mfw/${runId}`,
				createdAt: new Date().toISOString(),
			});
		} catch (e) {
			await rm(dir, { recursive: true, force: true });
			throw e;
		}
		return { path: seeded.treeDir, branch: `mfw/${runId}`, baseSha };
	}

	paths(runId: string): RunWorkspacePaths {
		return { root: this.root, workPath: join(this.dirOf(runId), "tree") };
	}

	/** The quarantine tip in the trusted primary, or null. */
	private async quarantineTip(runId: string): Promise<string | null> {
		const r = await git(
			["rev-parse", "--verify", "-q", `${quarantineRef(runId)}^{commit}`],
			this.primaryRoot,
		);
		return r.exitCode === 0 ? r.stdout.trim() : null;
	}

	async fetchResult(handle: RunWorkspaceHandle): Promise<RunWorkspaceResult> {
		const runId = this.runIdOf(handle.path);
		const ref = quarantineRef(runId);
		const marker = await this.readMarker(runId);
		const bundle = join(this.dirOf(runId), BUNDLE_REL);
		const hasBundle = await lstat(bundle).then(
			() => true,
			() => false,
		);
		if (
			marker &&
			!marker.importedTip &&
			hasBundle &&
			this.opts.assertProcessesDead
		) {
			const validate = this.opts.validate ?? validateRunResult;
			const out = await fetchRunResult({
				host: this.host,
				primaryRepo: this.primaryRoot,
				outboxRoot: this.dirOf(runId),
				bundleRel: BUNDLE_REL,
				runId,
				scratchRoot: await this.ensureScratch(),
				assertProcessesDead: () => this.opts.assertProcessesDead?.(runId),
				validate: (ctx) => validate(ctx, marker.baseSha),
			});
			await this.writeMarker({ ...marker, importedTip: out.tip });
		}
		return { ref, sha: await this.quarantineTip(runId) };
	}

	/**
	 * Save the run's uncommitted work without the host touching the clone: ask
	 * the in-sandbox helper through `control.jsonl`, wait for its ack, and (when
	 * `assertQuiescent` proves the run is stopped) import the bundle it wrote.
	 * The ack is sandbox-reported and only says the bundle is ready; the
	 * returned `sha` comes from the verified import, never from the ack.
	 * Replaces `snapshotWorktree` (`git add -A` in the work tree) for clones.
	 */
	async requestWip(
		handle: Pick<RunWorkspaceHandle, "path">,
		opts: { timeoutMs?: number; pollMs?: number } = {},
	): Promise<{ ack: WipAck; imported: { tip: string; wip: string[] } | null }> {
		const runId = this.runIdOf(handle.path);
		const marker = await this.readMarker(runId);
		if (!marker) throw new Error(`not an owned run workspace: ${handle.path}`);
		const control = this.opts.controlPath?.(runId);
		if (!control) throw new Error("requestWip needs controlPath");
		const id = randomBytes(8).toString("hex");
		await appendFile(control, wipControlLine(id));
		const ackPath = join(this.dirOf(runId), "outbox", wipAckFile());
		const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
		let ack: WipAck | null = null;
		while (!ack && Date.now() < deadline) {
			ack = await readAck(ackPath, id);
			if (!ack) await new Promise((r) => setTimeout(r, opts.pollMs ?? 100));
		}
		if (!ack) throw new Error(`the in-sandbox helper did not answer ${id}`);
		if (!ack.ok) return { ack, imported: null };
		const gate = this.opts.assertQuiescent;
		if (!gate) return { ack, imported: null };
		const validate = this.opts.validate ?? validateRunResult;
		const out = await fetchRunResult({
			host: this.host,
			primaryRepo: this.primaryRoot,
			outboxRoot: this.dirOf(runId),
			bundleRel: BUNDLE_REL,
			runId,
			scratchRoot: await this.ensureScratch(),
			assertProcessesDead: () => gate(runId),
			validate: (ctx) => validate(ctx, marker.baseSha),
		});
		return {
			ack,
			imported: { tip: out.tip, wip: out.wipRefs.map((w) => w.ref) },
		};
	}

	private async ensureScratch(): Promise<string> {
		await mkdir(this.scratch, { recursive: true, mode: 0o700 });
		return this.scratch;
	}

	/**
	 * True while the run's work has not been imported: a removal would lose it.
	 * The host cannot look inside the clone, so it does not guess at local
	 * files: only what the primary holds counts as saved.
	 */
	async hasLocalChanges(
		handle: Pick<RunWorkspaceHandle, "path">,
		_opts?: WorkspaceContentOptions,
	): Promise<boolean> {
		const runId = this.runIdOf(handle.path);
		const marker = await this.readMarker(runId);
		return !marker?.importedTip;
	}

	async remove(
		handle: RunWorkspaceHandle,
		opts?: {
			force?: boolean;
			deleteBranch?: boolean;
			reportIdentity?: WorktreeReportIdentity;
		},
	): Promise<void> {
		const owned = await this.ownership(handle.path);
		if (!owned) {
			throw new Error(
				`refusing to remove an unproven workspace: ${handle.path}`,
			);
		}
		if (!opts?.force && (await this.hasLocalChanges(handle))) {
			throw new Error(
				`workspace ${handle.path} is dirty: its result was never imported (pass force to discard it)`,
			);
		}
		await rm(this.dirOf(owned.runId), { recursive: true, force: true });
		if (opts?.deleteBranch) await this.deleteQuarantine(owned.runId);
	}

	/** Delete the run's quarantine refs in the trusted primary. */
	private async deleteQuarantine(runId: string): Promise<void> {
		const refs = await git(
			[
				"for-each-ref",
				"--format=%(refname)",
				quarantineRef(runId),
				quarantineWipPrefix(runId),
			],
			this.primaryRoot,
		);
		for (const ref of refs.stdout.split("\n").filter(Boolean)) {
			await git(["update-ref", "-d", ref], this.primaryRoot);
		}
	}

	/**
	 * What to save: the newest in-sandbox WIP snapshot when it builds on the
	 * imported branch tip (it also holds the uncommitted work), else the tip.
	 * Read in the trusted primary only.
	 */
	async newestWorkOf(
		handle: Pick<RunWorkspaceHandle, "path">,
	): Promise<string | null> {
		return this.newestWork(this.runIdOf(handle.path));
	}

	private async newestWork(runId: string): Promise<string | null> {
		const tip = await this.quarantineTip(runId);
		if (!tip) return null;
		const prefix = quarantineWipPrefix(runId);
		const refs = await git(
			["for-each-ref", "--format=%(refname) %(objectname)", prefix],
			this.primaryRoot,
		);
		const wips = refs.stdout
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				const [name = "", sha = ""] = l.split(" ");
				return { n: Number(name.slice(prefix.length)), sha };
			})
			.filter((w) => Number.isInteger(w.n))
			.sort((a, b) => b.n - a.n);
		for (const w of wips) {
			const desc = await git(
				["merge-base", "--is-ancestor", tip, w.sha],
				this.primaryRoot,
			);
			if (desc.exitCode === 0) return w.sha;
		}
		return tip;
	}

	async archive(
		handle: RunWorkspaceHandle,
		name: WorkspaceName,
	): Promise<WipArchive | null> {
		const runId = this.runIdOf(handle.path);
		const sha = await this.newestWork(runId);
		if (!sha || sha === handle.baseSha) return null;
		const base = `refs/heads/wip/${name.taskId ? `${name.taskId}-` : ""}${name.runId}`;
		for (let n = 1; n <= 20; n++) {
			const ref = n === 1 ? base : `${base}-${n}`;
			// Create-only: an earlier archive is never overwritten.
			const created = await git(["update-ref", ref, sha, ""], this.primaryRoot);
			if (created.exitCode === 0) {
				return { ref: ref.slice("refs/heads/".length), sha, created: true };
			}
			const existing = await git(
				["rev-parse", "--verify", "-q", ref],
				this.primaryRoot,
			);
			if (existing.exitCode === 0 && existing.stdout.trim() === sha) {
				return { ref: ref.slice("refs/heads/".length), sha, created: false };
			}
		}
		throw new Error(`could not create a wip branch for run ${name.runId}`);
	}

	async discard(
		handle: RunWorkspaceHandle,
		name: WorkspaceName,
	): Promise<{ archive: WipArchive | null; removed: boolean }> {
		const archive = await this.archive(handle, name);
		const owned = await this.ownership(handle.path);
		if (owned) {
			await this.remove(handle, { force: true, deleteBranch: true });
			return { archive, removed: true };
		}
		// No workspace: only the quarantine refs can be left.
		await this.deleteQuarantine(this.runIdOf(handle.path));
		return { archive, removed: false };
	}

	async ownership(path: string): Promise<OwnedRunWorkspace | null> {
		let runId: string;
		try {
			runId = this.runIdOf(path);
		} catch {
			return null;
		}
		const marker = await this.readMarker(runId);
		if (!marker) return null;
		const st = await lstat(path).catch(() => null);
		if (!st?.isDirectory()) return null;
		return {
			runId,
			path: resolve(path),
			branch: marker.branch,
			baseSha: marker.baseSha,
		};
	}

	async list(): Promise<string[]> {
		const entries = await readdir(this.root).catch(() => [] as string[]);
		const out: string[] = [];
		for (const id of entries) {
			const path = join(this.root, id, "tree");
			if (await this.ownership(path)) out.push(path);
		}
		return out;
	}
}
