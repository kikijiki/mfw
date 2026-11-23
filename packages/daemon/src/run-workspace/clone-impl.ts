import { randomBytes } from "node:crypto";
import {
	appendFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
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
import { isBookkeeping, MAX_SCOPE_PATHS } from "../scope-watchdog.ts";
import type { CacheDeclaration } from "./caches.ts";
import { preRebasePrefix } from "./rebase-clone.ts";
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
import { cloneConfig, seedWorkspace } from "./seed.ts";
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
/** Beside the clone, never bound: the hooks and config taken out before the final snapshot. */
const HELD_GIT_DIR = "held-git";
/** All a gitdir keeps for the final snapshot; the config is rewritten by the host. */
const CLEAN_GITDIR = new Set(["objects", "refs", "packed-refs", "HEAD"]);

interface Marker {
	version: 1;
	runId: string;
	primaryRoot: string;
	baseSha: string;
	branch: string;
	createdAt: string;
	/** Set once the host imported the result; the quarantine refs are then the record of the work. */
	importedTip?: string;
	/** Why the end-of-run import was refused. Final: the clone is kept for the owner. */
	importFailure?: string;
}

/**
 * Takes the end-of-run snapshot in a fresh sandbox, after every run process is
 * dead, so no agent process can race it. `run` resolves `failed` when the clone
 * cannot produce a result (a deleted or corrupt gitdir), `refused` when the
 * probe refuses what the agent left in the clone, and throws when the sandbox
 * could not start for any other reason, which is worth retrying.
 */
export interface FinalSnapshot {
	available(runId: string): boolean | Promise<boolean>;
	run(runId: string): Promise<"ok" | "failed" | "refused">;
}

/** What the host observed about an import, for the run's provenance record. */
export type ResultImportEvent =
	| { outcome: "imported"; tip: string; wipRefs: number; claim?: WipAck }
	| { outcome: "refused"; failure: string };

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
	/**
	 * The run's directory (`control/`, `outbox/`). The sandbox binds this outbox,
	 * so the helper's bundle and ack are read from it. Without it they are read
	 * from the workspace's own `outbox/`.
	 */
	runDirOf?: (runId: string) => string;
	/** The end-of-run snapshot. Without it, a bundle already in the outbox is imported as is. */
	finalSnapshot?: FinalSnapshot;
	/** Refuse a result bundle larger than this. Default: `fetchRunResult`'s cap. */
	maxBundleBytes?: number;
	/** Told what the host observed at the end-of-run import. Must not throw. */
	onResultImport?: (
		runId: string,
		event: ResultImportEvent,
	) => void | Promise<void>;
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

/** A result changing more paths than this is refused rather than half-read. */
export const MAX_RESULT_ENTRIES = 20_000;
/** A whole tree may be far larger than a change; only its symlinks are kept. */
const MAX_TREE_ENTRIES = 2_000_000;
const MAX_TREE_SYMLINKS = 5_000;
const MAX_LINK_HOPS = 40;
const MAX_LINK_TARGET_BYTES = 4096;

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
		// Streamed and bounded: a tail-kept listing drops the entries that sort first.
		const parts: string[] = [];
		await ctx.host.records(
			["diff-tree", "-r", "-z", "--raw", "--no-renames", baseSha, ref],
			{ cwd: ctx.bareRepo, repo: ctx.bareRepo },
			{ maxRecords: MAX_RESULT_ENTRIES * 2 },
			(record) => parts.push(record),
		);
		const addedLinks: string[] = [];
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
			if (newMode === MODE_SYMLINK) addedLinks.push(path);
		}
		if (addedLinks.length > 0) {
			await assertLinksStayInTree(ctx, ref, addedLinks);
		}
	}
}

/** Read a symlink's target exactly; a target past the output cap is refused. */
async function readLinkTarget(
	ctx: FetchValidationContext,
	sha: string,
): Promise<string> {
	const r = await ctx.host.run(["cat-file", "-p", sha], {
		cwd: ctx.bareRepo,
		repo: ctx.bareRepo,
		maxOutputBytes: MAX_LINK_TARGET_BYTES,
	});
	if (r.exitCode !== 0 || r.raw.truncated) {
		throw new HostGitError("validation", "a symlink target cannot be read");
	}
	return r.raw.stdout;
}

/**
 * Resolve each added symlink against the result tree, component by component
 * and following the tree's other symlinks, as a checkout would. Refuses a
 * target that leaves the tree, enters a `.git`, loops, or has a `..` after a
 * symlink (its meaning then depends on where that link points).
 */
async function assertLinksStayInTree(
	ctx: FetchValidationContext,
	ref: string,
	added: readonly string[],
): Promise<void> {
	const blobs = new Map<string, string>();
	await ctx.host.records(
		["ls-tree", "-r", "-z", "--full-tree", ref],
		{ cwd: ctx.bareRepo, repo: ctx.bareRepo },
		{ maxRecords: MAX_TREE_ENTRIES },
		(record) => {
			if (!record.startsWith(`${MODE_SYMLINK} `)) return;
			const tab = record.indexOf("\t");
			blobs.set(
				record.slice(tab + 1),
				record.slice(0, tab).split(" ")[2] ?? "",
			);
			if (blobs.size > MAX_TREE_SYMLINKS) {
				throw new HostGitError(
					"validation",
					"the result has too many symlinks",
				);
			}
		},
	);
	const targets = new Map<string, string>();
	const targetOf = async (path: string): Promise<string> => {
		const known = targets.get(path);
		if (known !== undefined) return known;
		const text = await readLinkTarget(ctx, blobs.get(path) as string);
		targets.set(path, text);
		return text;
	};
	for (const link of added) {
		const refuse = (why: string): never => {
			throw new HostGitError(
				"validation",
				`the run added a symlink that ${why}: ${JSON.stringify(link.slice(0, 120))}`,
			);
		};
		const first = await targetOf(link);
		if (first.startsWith("/")) refuse("leaves the tree");
		const at = dirname(link) === "." ? [] : dirname(link).split("/");
		const rest = first.split("/");
		let hops = 0;
		while (rest.length > 0) {
			const part = rest.shift() as string;
			if (part === "" || part === ".") continue;
			if (part === "..") {
				if (at.pop() === undefined) refuse("leaves the tree");
				continue;
			}
			if (part.toLowerCase() === ".git") refuse("points into .git");
			at.push(part);
			const here = at.join("/");
			if (!blobs.has(here)) continue;
			if (rest.includes("..")) refuse("has .. after a symlink");
			if (++hops > MAX_LINK_HOPS) refuse("loops");
			const next = await targetOf(here);
			if (next.startsWith("/")) refuse("leaves the tree");
			at.pop();
			rest.unshift(...next.split("/"));
		}
	}
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

/** What a WIP request brought back. A `live` sample exists only as this listing. */
export interface WipImport {
	tip: string;
	wip: string[];
	live?: boolean;
	files?: string[];
	truncated?: boolean;
}

/** The outbox must be a real directory: the root above it is host-only. */
async function assertRealDirectory(path: string): Promise<void> {
	const st = await lstat(path);
	if (!st.isDirectory()) throw new Error("the run outbox is not a directory");
}

/** A live sample's bounds: it runs repeatedly, beside the agent. */
const LIVE_MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const LIVE_MAX_REFS = 128;

/** Failures that describe the run's result. Anything else may pass on a retry. */
const FINAL_IMPORT_FAILURES = new Set([
	"bad_bundle",
	"no_branch",
	"validation",
]);

// One snapshot or import per run at a time: they share the outbox's ack and
// bundle. Module-level because callers build a workspace object per call.
const runQueues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const previous = runQueues.get(key) ?? Promise.resolve();
	const next = previous.then(fn, fn);
	const tail = next.then(
		() => {},
		() => {},
	);
	runQueues.set(key, tail);
	void tail.then(() => {
		if (runQueues.get(key) === tail) runQueues.delete(key);
	});
	return next;
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

	/** Where the helper's files are: the root is host-only, `outbox/` is the sandbox's. */
	private outboxRoot(runId: string): string {
		return this.opts.runDirOf?.(runId) ?? this.dirOf(runId);
	}

	async fetchResult(handle: RunWorkspaceHandle): Promise<RunWorkspaceResult> {
		const runId = this.runIdOf(handle.path);
		const ref = quarantineRef(runId);
		await serialized(this.dirOf(runId), () => this.importFinal(runId));
		const marker = await this.readMarker(runId);
		return {
			ref,
			sha: await this.quarantineTip(runId),
			...(marker?.importFailure ? { failure: marker.importFailure } : {}),
		};
	}

	/** The end-of-run import, at most once per run. */
	private async importFinal(runId: string): Promise<void> {
		const marker = await this.readMarker(runId);
		const assertDead = this.opts.assertProcessesDead;
		if (!marker || marker.importedTip || marker.importFailure || !assertDead) {
			return;
		}
		const root = this.outboxRoot(runId);
		const bundle = join(root, BUNDLE_REL);
		const snapshot = this.opts.finalSnapshot;
		const fresh = snapshot ? await snapshot.available(runId) : false;
		// The helper's own account of the snapshot. Recorded, never relied on.
		let claim: WipAck | null = null;
		if (fresh && snapshot) {
			try {
				await assertDead(runId);
			} catch (e) {
				throw new HostGitError(
					"precondition",
					`run processes are not confirmed dead: ${e instanceof Error ? e.message : String(e)}`,
				);
			}
			// Whatever the agent left here is not the result. `rm` does not follow links.
			await rm(bundle, { recursive: true, force: true });
			await rm(join(root, "outbox", wipAckFile()), {
				recursive: true,
				force: true,
			});
			if (!(await this.neutralizeGit(marker))) {
				await this.refuseImport(marker, "snapshot_failed");
				return;
			}
			const outcome = await snapshot.run(runId);
			if (outcome !== "ok") {
				await this.refuseImport(
					marker,
					outcome === "refused" ? "snapshot_refused" : "snapshot_failed",
				);
				return;
			}
			claim = await readAck(join(root, "outbox", wipAckFile()), "final");
		} else if (
			!(await lstat(bundle).then(
				() => true,
				() => false,
			))
		) {
			return;
		}
		const validate = this.opts.validate ?? validateRunResult;
		try {
			const out = await fetchRunResult({
				host: this.host,
				primaryRepo: this.primaryRoot,
				outboxRoot: root,
				bundleRel: BUNDLE_REL,
				runId,
				scratchRoot: await this.ensureScratch(),
				assertProcessesDead: () => assertDead(runId),
				validate: (ctx) => validate(ctx, marker.baseSha),
				...(this.opts.maxBundleBytes
					? { maxBundleBytes: this.opts.maxBundleBytes }
					: {}),
			});
			await this.writeMarker({ ...marker, importedTip: out.tip });
			await this.opts.onResultImport?.(runId, {
				outcome: "imported",
				tip: out.tip,
				wipRefs: out.wipRefs.length,
				...(claim ? { claim } : {}),
			});
		} catch (e) {
			if (
				fresh &&
				e instanceof HostGitError &&
				FINAL_IMPORT_FAILURES.has(e.code)
			) {
				await this.refuseImport(marker, e.code);
				return;
			}
			throw e;
		}
	}

	/**
	 * Rebuild the gitdir from what a snapshot needs: `objects`, `refs`,
	 * `packed-refs` and `HEAD`, plus a host-written config. Everything else the
	 * agent could have used to redirect or configure git (`commondir`,
	 * `worktrees/`, `info/`, `shallow`, hooks, `objects/info/alternates`) moves
	 * out, so the snapshot sandbox passes the unchanged probe because those
	 * files are really gone. Only with every run process dead. `rename` follows
	 * no links, and the files land beside the clone, where no sandbox binds them
	 * and nothing runs them. False when the clone has no usable gitdir or tree.
	 */
	private async neutralizeGit(marker: Marker): Promise<boolean> {
		const dir = this.dirOf(marker.runId);
		const gitDir = join(dir, "git");
		const tree = join(dir, "tree");
		const kind = async (path: string) => {
			const st = await lstat(path).catch(() => null);
			return st?.isDirectory()
				? "dir"
				: st?.isFile()
					? "file"
					: st
						? "other"
						: null;
		};
		if (
			(await kind(gitDir)) !== "dir" ||
			(await kind(tree)) !== "dir" ||
			(await kind(join(gitDir, "objects"))) !== "dir" ||
			(await kind(join(gitDir, "refs"))) !== "dir" ||
			(await kind(join(gitDir, "HEAD"))) !== "file" ||
			!["file", null].includes(await kind(join(gitDir, "packed-refs")))
		) {
			return false;
		}
		const hold = join(dir, HELD_GIT_DIR, randomBytes(6).toString("hex"));
		await mkdir(hold, { recursive: true, mode: 0o700 });
		const moveOut = (from: string, name: string) =>
			rename(from, join(hold, name)).catch((e: NodeJS.ErrnoException) => {
				if (e.code !== "ENOENT") throw e;
			});
		for (const name of await readdir(gitDir)) {
			if (!CLEAN_GITDIR.has(name)) await moveOut(join(gitDir, name), name);
		}
		await moveOut(join(gitDir, "objects", "info"), "objects-info");
		await mkdir(join(gitDir, "objects", "info"));
		await moveOut(join(tree, ".git"), "tree-dot-git");
		await writeFile(
			join(gitDir, "config"),
			cloneConfig(marker.baseSha.length === 64),
			{ flag: "wx", mode: 0o600 },
		);
		return true;
	}

	private async refuseImport(marker: Marker, failure: string): Promise<void> {
		await this.writeMarker({ ...marker, importFailure: failure });
		this.opts.log?.(`run ${marker.runId}: result refused (${failure})`);
		await this.opts.onResultImport?.(marker.runId, {
			outcome: "refused",
			failure,
		});
	}

	/**
	 * Save the run's uncommitted work without the host touching the clone: ask
	 * the in-sandbox helper through `control.jsonl`, wait for its ack, and import
	 * the bundle it wrote. The ack is sandbox-reported and only says the bundle
	 * is ready; every returned ref and sha comes from the verified import.
	 *
	 * A run proven quiescent imports into the quarantine refs. A running one
	 * with a host-anchored outbox (`runDirOf`) is only read in a throwaway repo
	 * and never enters the primary. Replaces `snapshotWorktree` for clones.
	 */
	async requestWip(
		handle: Pick<RunWorkspaceHandle, "path">,
		opts: { timeoutMs?: number; pollMs?: number } = {},
	): Promise<{
		ack: WipAck;
		imported: WipImport | null;
	}> {
		const runId = this.runIdOf(handle.path);
		return serialized(this.dirOf(runId), () =>
			this.requestWipNow(runId, handle, opts),
		);
	}

	private async requestWipNow(
		runId: string,
		handle: Pick<RunWorkspaceHandle, "path">,
		opts: { timeoutMs?: number; pollMs?: number },
	): Promise<{
		ack: WipAck;
		imported: WipImport | null;
	}> {
		const marker = await this.readMarker(runId);
		if (!marker) throw new Error(`not an owned run workspace: ${handle.path}`);
		const control = this.opts.controlPath?.(runId);
		if (!control) throw new Error("requestWip needs controlPath");
		const id = randomBytes(8).toString("hex");
		await appendFile(control, wipControlLine(id));
		const root = this.outboxRoot(runId);
		const ackPath = join(root, "outbox", wipAckFile());
		const deadline = Date.now() + (opts.timeoutMs ?? 30_000);
		let ack: WipAck | null = null;
		while (!ack && Date.now() < deadline) {
			ack = await readAck(ackPath, id);
			if (!ack) await new Promise((r) => setTimeout(r, opts.pollMs ?? 100));
		}
		if (!ack) throw new Error(`the in-sandbox helper did not answer ${id}`);
		if (!ack.ok) return { ack, imported: null };
		const gate = this.opts.assertQuiescent;
		if (!gate && this.opts.runDirOf === undefined) {
			return { ack, imported: null };
		}
		if (!gate) return this.readLiveSample(runId, marker, root, ack);
		const validate = this.opts.validate ?? validateRunResult;
		const out = await fetchRunResult({
			host: this.host,
			primaryRepo: this.primaryRoot,
			outboxRoot: root,
			bundleRel: BUNDLE_REL,
			runId,
			scratchRoot: await this.ensureScratch(),
			assertProcessesDead: () => gate(runId),
			validate: (ctx) => validate(ctx, marker.baseSha),
			...(this.opts.maxBundleBytes
				? { maxBundleBytes: this.opts.maxBundleBytes }
				: {}),
		});
		return {
			ack,
			imported: { tip: out.tip, wip: out.wipRefs.map((w) => w.ref) },
		};
	}

	/**
	 * Verify a running run's bundle in a throwaway repo and list what it changed
	 * there. Nothing enters the primary, so samples cost no primary disk. Every
	 * ref counts: the helper shares the agent's uid, so a forged clean snapshot
	 * must not hide a change another ref holds.
	 */
	private async readLiveSample(
		runId: string,
		marker: Marker,
		root: string,
		ack: WipAck,
	): Promise<{ ack: WipAck; imported: WipImport }> {
		const files = new Set<string>();
		let truncated = false;
		const out = await fetchRunResult({
			host: this.host,
			primaryRepo: this.primaryRoot,
			outboxRoot: root,
			bundleRel: BUNDLE_REL,
			runId,
			scratchRoot: await this.ensureScratch(),
			assertProcessesDead: () => assertRealDirectory(join(root, "outbox")),
			destination: "live",
			maxBundleBytes: Math.min(
				this.opts.maxBundleBytes ?? LIVE_MAX_BUNDLE_BYTES,
				LIVE_MAX_BUNDLE_BYTES,
			),
			maxRefs: LIVE_MAX_REFS,
			validate: async (ctx) => {
				for (const ref of [ctx.headRef, ...ctx.wipRefs]) {
					try {
						await ctx.host.records(
							[
								"diff-tree",
								"-r",
								"-z",
								"--name-only",
								"--no-renames",
								marker.baseSha,
								ref,
							],
							{ cwd: ctx.bareRepo, repo: ctx.bareRepo },
							{ maxRecords: MAX_SCOPE_PATHS },
							(path) => {
								if (!isBookkeeping(path)) files.add(path);
								if (files.size > MAX_SCOPE_PATHS) {
									throw new HostGitError(
										"validation",
										"too many changed paths",
									);
								}
							},
						);
					} catch (e) {
						if (!(e instanceof HostGitError) || e.code !== "validation") {
							throw e;
						}
						truncated = true;
						return;
					}
				}
			},
		});
		return {
			ack,
			imported: {
				tip: out.tip,
				wip: out.wipRefs.map((w) => w.ref),
				live: true,
				files: [...files].sort(),
				truncated,
			},
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
				preRebasePrefix(runId),
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
		return tip ? this.newestOn(tip, quarantineWipPrefix(runId)) : null;
	}

	/** The highest-numbered snapshot under `prefix` that builds on `tip`, else `tip`. */
	private async newestOn(tip: string, prefix: string): Promise<string> {
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
