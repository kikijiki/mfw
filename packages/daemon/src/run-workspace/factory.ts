import type { RunWorkspace, RunWorkspaceHandle } from "./run-workspace.ts";
import { WorktreeRunWorkspace } from "./worktree-impl.ts";

/** The workspace implementation for a project. Worktrees are the only one so far. */
export function createRunWorkspace(projectRoot: string): RunWorkspace {
	return new WorktreeRunWorkspace(projectRoot);
}

/**
 * The create/remove pair the execution targets inject in tests. Kept so those
 * seams do not change while every real caller goes through `RunWorkspace`.
 */
export interface WorkspacePort {
	create(runId: string, base?: string): Promise<RunWorkspaceHandle>;
	remove(handle: RunWorkspaceHandle): Promise<void>;
}

export function workspacePort(workspace: RunWorkspace): WorkspacePort {
	return {
		create: (runId, base) => workspace.seed(runId, base),
		remove: (handle) => workspace.remove(handle),
	};
}
