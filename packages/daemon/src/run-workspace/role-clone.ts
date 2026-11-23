/**
 * A host-seeded clone for a read-only role (plan, import, action, brain,
 * reviewer). These roles read the project and build nothing, so they need
 * neither the project's clone setting nor its dev shell: they get a private
 * copy of one commit, mounted read-only, whatever the project's workspace kind.
 *
 * Named `ro-<runId>` under the workspace root, so the verifier's startup sweep
 * (`verify-*`) never removes one a surviving run is using. The run's script
 * removes it when the run ends.
 *
 * The workspace root is shared by every project of a daemon (and by a second
 * daemon), and a clone exists before its run's session does, so the sweep
 * removes only a clone it can show is orphaned. The marker names the owner
 * (instance, pid, pid start time) and when the clone was made: a run whose
 * session is dead still keeps its clone while this process is launching it
 * (`launchGraceMs`), and while another live daemon owns it (`orphanAgeMs`).
 */
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readRegularFile } from "../containment/safe-file.ts";
import { git } from "../git.ts";
import { assertRunId } from "../host-git/fetch.ts";
import {
	cloneAgeMs,
	INSTANCE,
	ownCloneOwner,
	ownerAlive,
	readOwner,
} from "./clone-owner.ts";
import { workspaceRootOf } from "./factory.ts";
import { removeTree } from "./remove-tree.ts";
import { seedWorkspace } from "./seed.ts";

export interface RoleClone {
	/** `<root>/tree`, the real path the sandbox mounts read-only. */
	tree: string;
	/** The directory to remove when the run ends. */
	root: string;
	sha: string;
}

const ID_PREFIX = "ro-";
const MARKER = "mfw-workspace.json";

/** A clone this process made is not abandoned while its launch may still be under way. */
const LAUNCH_GRACE_MS = 10 * 60_000;
/** A clone another live process owns is not abandoned until this old. */
const ORPHAN_AGE_MS = 24 * 60 * 60_000;
/** Clone ids this process is creating, across every caller. */
const MAKING = new Set<string>();

export const roleCloneId = (runId: string): string => `${ID_PREFIX}${runId}`;

/** Seed a private clone of `rev`, a commit in the trusted primary. */
export async function createRoleClone(
	projectRoot: string,
	runId: string,
	rev = "HEAD",
): Promise<RoleClone> {
	const primaryRoot = resolve(projectRoot);
	const workspaceRoot = workspaceRootOf(primaryRoot);
	if (!workspaceRoot) {
		throw new Error(`project ${primaryRoot} has no run workspace settings`);
	}
	const id = roleCloneId(runId);
	assertRunId(id);
	const resolved = await git(
		["rev-parse", "--verify", "-q", `${rev}^{commit}`],
		primaryRoot,
	);
	if (resolved.exitCode !== 0) {
		throw new Error(`cannot seed a read-only clone: no commit ${rev}`);
	}
	const sha = resolved.stdout.trim();
	await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
	// Making from before the first directory exists: a sweep elsewhere in this
	// process must not see a half-made clone.
	MAKING.add(id);
	try {
		const seeded = await seedWorkspace({
			runId: id,
			workspaceRoot,
			primaryRoot,
			baseSha: sha,
			history: "tip",
		});
		await writeFile(
			join(seeded.dir, MARKER),
			`${JSON.stringify({
				version: 1,
				runId: id,
				role: "read-only",
				baseSha: sha,
				primaryRoot,
				owner: ownCloneOwner(),
				createdAt: new Date().toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		const tree = await realpath(seeded.treeDir);
		return { tree, root: dirname(tree), sha };
	} finally {
		MAKING.delete(id);
	}
}

/**
 * The same layout with nothing in it, for a role that must not see the
 * project at all (the critic). Swept like any other role clone.
 */
export async function createEmptyRoleTree(
	projectRoot: string,
	runId: string,
): Promise<Pick<RoleClone, "tree" | "root">> {
	const primaryRoot = resolve(projectRoot);
	const workspaceRoot = workspaceRootOf(primaryRoot);
	if (!workspaceRoot) {
		throw new Error(`project ${primaryRoot} has no run workspace settings`);
	}
	const id = roleCloneId(runId);
	assertRunId(id);
	const dir = join(workspaceRoot, id);
	MAKING.add(id);
	try {
		await mkdir(join(dir, "tree"), { recursive: true, mode: 0o700 });
		await mkdir(join(dir, "git"), { mode: 0o700 });
		await writeFile(
			join(dir, MARKER),
			`${JSON.stringify({
				version: 1,
				runId: id,
				role: "read-only",
				baseSha: null,
				primaryRoot,
				owner: ownCloneOwner(),
				createdAt: new Date().toISOString(),
			})}\n`,
			{ mode: 0o600 },
		);
		const tree = await realpath(join(dir, "tree"));
		return { tree, root: dirname(tree) };
	} finally {
		MAKING.delete(id);
	}
}

export interface RoleCloneSweepOptions {
	/** How long this process's own clone is kept while its session may not be up. Default 10 minutes. */
	launchGraceMs?: number;
	/** How old a clone owned by another live process must be to count as abandoned. Default 24 hours. */
	orphanAgeMs?: number;
}

/**
 * Remove this project's role clones whose run is gone: a daemon crash, or a
 * script killed before its own cleanup. The workspace root is shared, so only a
 * clone whose host-only marker names this project is considered, and only a
 * session known to be dead (`false`, not an unknown `null`) lets it go. Even
 * then a clone is spared while it may be in flight: made by this process
 * within the launch grace, being made right now, or owned by another live
 * process. A clone with no owner record (made before records existed) is
 * treated as this process's own, by its age.
 */
export async function sweepRoleClones(
	projectRoot: string,
	sessionLive: (runId: string) => Promise<boolean | null>,
	options: RoleCloneSweepOptions = {},
): Promise<number> {
	const primaryRoot = resolve(projectRoot);
	const workspaceRoot = workspaceRootOf(primaryRoot);
	if (!workspaceRoot) return 0;
	const launchGrace = options.launchGraceMs ?? LAUNCH_GRACE_MS;
	const orphanAge = options.orphanAgeMs ?? ORPHAN_AGE_MS;
	let removed = 0;
	const ids = await readdir(workspaceRoot).catch(() => [] as string[]);
	for (const id of ids) {
		if (!id.startsWith(ID_PREFIX)) continue;
		const dir = join(workspaceRoot, id);
		const marker = await readRegularFile(join(dir, MARKER), 4096);
		let meta: { primaryRoot?: unknown; owner?: unknown; createdAt?: unknown };
		try {
			meta = marker ? JSON.parse(marker.buffer.toString("utf8")) : {};
		} catch {
			continue;
		}
		if (meta.primaryRoot !== primaryRoot) continue;
		if (MAKING.has(id)) continue;
		const live = await sessionLive(id.slice(ID_PREFIX.length)).catch(
			() => null,
		);
		if (live !== false) continue;
		const age = await cloneAgeMs(dir, meta.createdAt).catch(() => 0);
		const owner = readOwner(meta.owner);
		if (!owner || owner.instance === INSTANCE) {
			if (age < launchGrace) continue;
		} else if (ownerAlive(owner) && age < orphanAge) {
			continue;
		}
		if ((await removeTree(dir)).length === 0) removed++;
	}
	return removed;
}
