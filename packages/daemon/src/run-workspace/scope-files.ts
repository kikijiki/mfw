/**
 * The scope watchdog's file listing for a clone run (backstage
 * architecture.md, "Run workspace").
 *
 * A clone's work tree is agent-writable, so the host never runs `git diff`
 * there. A sample asks the in-sandbox helper for a WIP snapshot, imports the
 * verified bundle, and diffs the run's newest imported work against its base in
 * the trusted primary. When the run cannot be proven quiescent the snapshot is
 * not imported and there is no sample, which never kills.
 */
import { changedFilesInRef } from "../scope-watchdog.ts";
import type { CloneRunWorkspace } from "./clone-impl.ts";

export async function cloneScopeFiles(
	workspace: Pick<CloneRunWorkspace, "requestWip" | "newestWorkOf">,
	primaryRoot: string,
	worktreePath: string,
	baseSha: string,
	opts: { timeoutMs?: number } = {},
): Promise<{ files: string[]; truncated: boolean }> {
	const handle = { path: worktreePath };
	const { ack, imported } = await workspace.requestWip(handle, opts);
	if (!ack.ok)
		throw new Error(`wip snapshot failed: ${ack.error ?? "no reason"}`);
	if (!imported)
		throw new Error("wip snapshot not imported: run not quiescent");
	const work = await workspace.newestWorkOf(handle);
	if (!work) throw new Error("no imported work to diff");
	return changedFilesInRef(primaryRoot, baseSha, work);
}
