/**
 * The scope watchdog's file listing for a clone run.
 *
 * A clone's work tree is agent-writable, so the host never runs `git diff`
 * there. A sample asks the in-sandbox helper for a WIP snapshot, verifies the
 * bundle in a throwaway repo and lists what every ref changed against the
 * run's base, so nothing enters the primary. The helper shares the agent's uid,
 * so samples are advisory: only the final import is trusted. When nothing could
 * be read there is no sample, and the supervisor counts that (`unsampled`).
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
	if (imported.live && imported.files) {
		return { files: imported.files, truncated: imported.truncated === true };
	}
	const files = new Set<string>();
	let truncated = false;
	for (const ref of [imported.tip, ...imported.wip]) {
		const listed = await changedFilesInRef(primaryRoot, baseSha, ref);
		for (const file of listed.files) files.add(file);
		truncated ||= listed.truncated;
	}
	return { files: [...files].sort(), truncated };
}
