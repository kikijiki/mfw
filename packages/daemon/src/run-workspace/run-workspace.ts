/**
 * The seam between a run and the place its files live. Every caller that creates, inspects,
 * archives or removes a run's workspace goes through `RunWorkspace`, so the
 * storage strategy (a git worktree today, a private clone later) can change
 * without touching them.
 */

/** A run's workspace on disk: where it is, its branch and the commit it was cut from. */
export interface RunWorkspaceHandle {
	path: string;
	branch: string;
	baseSha: string;
}

/** A workspace whose durable ownership marker was read back and verified. */
export interface OwnedRunWorkspace extends RunWorkspaceHandle {
	runId: string;
}

/** A run's work saved on a plain branch by `RunWorkspace.archive`. */
export interface WipArchive {
	/** Short branch name, `wip/<task>-<run>` (a `-<n>` suffix if taken). */
	ref: string;
	sha: string;
	/** False when an identical archive already existed. */
	created: boolean;
}

export type WorktreeReportIdentity =
	| { state: "absent" }
	| { state: "present"; sha256: string };

export interface WorkspaceContentOptions {
	/** Exact report state committed by ingest_report. */
	reportIdentity?: WorktreeReportIdentity;
}

export interface WorkspaceName {
	runId: string;
	taskId?: string | null;
}

export interface RunWorkspacePaths {
	/** Directory that holds every run workspace of the project. */
	root: string;
	/** Where this run's files are (or will be) on the host. */
	workPath: string;
}

/** The result a run left behind, as the host can read it. */
export interface RunWorkspaceResult {
	/** Branch the run committed to. */
	ref: string;
	/** Its tip, or null when the branch no longer exists. */
	sha: string | null;
	/** Why a clone's result was refused (a failure class). The clone is kept. */
	failure?: string;
}

export interface RunWorkspace {
	readonly kind: "worktree" | "clone";

	/** Create the workspace for `runId` from `base` (default: current HEAD). */
	seed(runId: string, base?: string): Promise<RunWorkspaceHandle>;

	/** Where a run's workspace lives. Pure: touches no disk. */
	paths(runId: string): RunWorkspacePaths;

	/**
	 * Read what the run left behind: the ref the primary holds it under and its
	 * tip. A worktree shares the primary's refs, so this is a read. A clone's
	 * result arrives by a verified import (the first call after the run ends
	 * performs it), and `ref` is the primary's quarantine ref, not `branch`.
	 */
	fetchResult(handle: RunWorkspaceHandle): Promise<RunWorkspaceResult>;

	/**
	 * True if the workspace has local (including ignored) files that a removal
	 * would lose. `MFW_REPORT.json` is disposable only with a matching
	 * `reportIdentity`.
	 */
	hasLocalChanges(
		handle: Pick<RunWorkspaceHandle, "path">,
		opts?: WorkspaceContentOptions,
	): Promise<boolean>;

	/** Remove a positively identified workspace; refuses an unproven one. */
	remove(
		handle: RunWorkspaceHandle,
		opts?: {
			force?: boolean;
			deleteBranch?: boolean;
			reportIdentity?: WorktreeReportIdentity;
		},
	): Promise<void>;

	/** Save the run's work on a `wip/` branch; null when there is nothing to save. */
	archive(
		handle: RunWorkspaceHandle,
		name: WorkspaceName,
	): Promise<WipArchive | null>;

	/** Archive, then throw the workspace and its `mfw/` branch away. */
	discard(
		handle: RunWorkspaceHandle,
		name: WorkspaceName,
	): Promise<{ archive: WipArchive | null; removed: boolean }>;

	/** The durable identity at `path`, only when every marker agrees. */
	ownership(path: string): Promise<OwnedRunWorkspace | null>;

	/** Paths of the workspaces the backing store currently tracks. */
	list(): Promise<string[]>;
}
