/**
 * The scope watchdog's file listing for a clone run (backstage
 * architecture.md, "Run workspace").
 *
 * A clone's work tree is agent-writable, so the host never runs `git diff`
 * there. A sample asks the in-sandbox helper for a WIP snapshot, imports the
 * verified bundle, and diffs it against the run's base in the trusted primary.
 * Every imported ref counts, not just the newest: the helper shares the agent's
 * uid, so a forged "clean" snapshot must not hide a change an earlier ref holds.
 * When nothing was imported there is no sample, which never kills.
 */
import { changedFilesInRef } from "../scope-watchdog.ts";
import type { CloneRunWorkspace } from "./clone-impl.ts";

export async function cloneScopeFiles(
	workspace: Pick<CloneRunWorkspace, "requestWip">,
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
	const files = new Set<string>();
	let truncated = false;
	for (const ref of [imported.tip, ...imported.wip]) {
		const listed = await changedFilesInRef(primaryRoot, baseSha, ref);
		for (const file of listed.files) files.add(file);
		truncated ||= listed.truncated;
	}
	return { files: [...files].sort(), truncated };
}
