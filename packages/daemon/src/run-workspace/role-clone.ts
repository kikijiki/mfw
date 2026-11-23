/**
 * A host-seeded clone for a read-only role (plan, import, action, brain,
 * reviewer). These roles read the project and build nothing, so they need
 * neither the project's clone setting nor its dev shell: they get a private
 * copy of one commit, mounted read-only, whatever the project's workspace kind.
 *
 * Named `ro-<runId>` under the workspace root, so the verifier's startup sweep
 * (`verify-*`) never removes one a surviving run is using. The run's script
 * removes it when the run ends.
 */
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readRegularFile } from "../containment/safe-file.ts";
import { git } from "../git.ts";
import { assertRunId } from "../host-git/fetch.ts";
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
	const seeded = await seedWorkspace({
		runId: id,
		workspaceRoot,
		primaryRoot,
		baseSha: sha,
		history: "tip",
	});
	await writeFile(
		join(seeded.dir, MARKER),
		`${JSON.stringify({ version: 1, runId: id, role: "read-only", baseSha: sha, primaryRoot })}\n`,
		{ mode: 0o600 },
	);
	const tree = await realpath(seeded.treeDir);
	return { tree, root: dirname(tree), sha };
}

/**
 * Remove this project's role clones whose run is gone: a daemon crash, or a
 * script killed before its own cleanup. The workspace root is shared, so only a
 * clone whose host-only marker names this project is considered, and only a
 * session known to be dead (`false`, not an unknown `null`) lets it go.
 */
export async function sweepRoleClones(
	projectRoot: string,
	sessionLive: (runId: string) => Promise<boolean | null>,
): Promise<number> {
	const primaryRoot = resolve(projectRoot);
	const workspaceRoot = workspaceRootOf(primaryRoot);
	if (!workspaceRoot) return 0;
	let removed = 0;
	const ids = await readdir(workspaceRoot).catch(() => [] as string[]);
	for (const id of ids) {
		if (!id.startsWith(ID_PREFIX)) continue;
		const dir = join(workspaceRoot, id);
		const marker = await readRegularFile(join(dir, MARKER), 4096);
		let owner: unknown;
		try {
			owner = marker
				? JSON.parse(marker.buffer.toString("utf8")).primaryRoot
				: null;
		} catch {
			continue;
		}
		if (owner !== primaryRoot) continue;
		const live = await sessionLive(id.slice(ID_PREFIX.length)).catch(
			() => null,
		);
		if (live !== false) continue;
		if ((await removeTree(dir)).length === 0) removed++;
	}
	return removed;
}
