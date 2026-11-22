import { join } from "node:path";
import { git } from "../git.ts";
import { WorktreeManager } from "../worktree.ts";
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

/**
 * `RunWorkspace` over git worktrees under `<repo>/worktrees`: today's
 * behaviour, unchanged. This is the only module that imports `WorktreeManager`.
 */
export class WorktreeRunWorkspace implements RunWorkspace {
	readonly kind = "worktree";
	private readonly manager: WorktreeManager;

	constructor(private readonly repoRoot: string) {
		this.manager = new WorktreeManager(repoRoot);
	}

	seed(runId: string, base?: string): Promise<RunWorkspaceHandle> {
		return this.manager.create(runId, base);
	}

	paths(runId: string): RunWorkspacePaths {
		return { root: this.manager.dir, workPath: join(this.manager.dir, runId) };
	}

	async fetchResult(handle: RunWorkspaceHandle): Promise<RunWorkspaceResult> {
		// The worktree shares the primary's object store, so the result is
		// already the branch tip there: there is nothing to import.
		const tip = await git(
			["rev-parse", "--verify", "-q", `refs/heads/${handle.branch}`],
			this.repoRoot,
		);
		return {
			ref: handle.branch,
			sha: tip.exitCode === 0 ? tip.stdout.trim() : null,
		};
	}

	hasLocalChanges(
		handle: Pick<RunWorkspaceHandle, "path">,
		opts?: WorkspaceContentOptions,
	): Promise<boolean> {
		return this.manager.hasLocalChanges(handle, opts);
	}

	remove(
		handle: RunWorkspaceHandle,
		opts?: {
			force?: boolean;
			deleteBranch?: boolean;
			reportIdentity?: WorktreeReportIdentity;
		},
	): Promise<void> {
		return this.manager.remove(handle, opts);
	}

	archive(
		handle: RunWorkspaceHandle,
		name: WorkspaceName,
	): Promise<WipArchive | null> {
		return this.manager.archiveWip(handle, name);
	}

	discard(
		handle: RunWorkspaceHandle,
		name: WorkspaceName,
	): Promise<{ archive: WipArchive | null; removed: boolean }> {
		return this.manager.discard(handle, name);
	}

	ownership(path: string): Promise<OwnedRunWorkspace | null> {
		return this.manager.ownership(path);
	}

	list(): Promise<string[]> {
		return this.manager.list();
	}
}
