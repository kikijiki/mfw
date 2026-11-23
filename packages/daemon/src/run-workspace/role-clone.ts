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
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { git } from "../git.ts";
import { assertRunId } from "../host-git/fetch.ts";
import { workspaceRootOf } from "./factory.ts";
import { seedWorkspace } from "./seed.ts";

export interface RoleClone {
	/** `<root>/tree`, the real path the sandbox mounts read-only. */
	tree: string;
	/** The directory to remove when the run ends. */
	root: string;
	sha: string;
}

export const roleCloneId = (runId: string): string => `ro-${runId}`;

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
		join(seeded.dir, "mfw-workspace.json"),
		`${JSON.stringify({ version: 1, runId: id, role: "read-only", baseSha: sha })}\n`,
		{ mode: 0o600 },
	);
	const tree = await realpath(seeded.treeDir);
	return { tree, root: dirname(tree), sha };
}
