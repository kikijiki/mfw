import { resolve } from "node:path";
import {
	isRunWorkspacePath,
	registerRunWorkspaceRoot,
} from "../host-git/legacy-guard.ts";
import { CloneRunWorkspace, type CloneWorkspaceOptions } from "./clone-impl.ts";
import type { RebaseCloneOptions } from "./rebase-clone.ts";
import type { RunWorkspace, RunWorkspaceHandle } from "./run-workspace.ts";
import { VerifierClones } from "./verifier-clone.ts";
import { WorktreeRunWorkspace } from "./worktree-impl.ts";

export type RunWorkspaceKind = "worktree" | "clone";

interface ProjectSetting {
	kind: RunWorkspaceKind;
	clone?: CloneWorkspaceOptions;
}

const settings = new Map<string, ProjectSetting>();

/**
 * Choose the implementation for a project (`runWorkspace` in its config).
 * Called when the project attaches; every `createRunWorkspace` call for that
 * root then follows it, so callers do not each read config. `clone` needs its
 * options (workspace root and the liveness proof); without a registration a
 * project uses worktrees.
 */
export function configureRunWorkspace(
	projectRoot: string,
	setting: ProjectSetting,
): void {
	if (setting.kind === "clone" && !setting.clone) {
		throw new Error("runWorkspace clone needs its workspace options");
	}
	if (setting.clone) registerRunWorkspaceRoot(setting.clone.workspaceRoot);
	settings.set(resolve(projectRoot), setting);
}

/** Forget a project's setting (detach, and test cleanup). */
export function clearRunWorkspace(projectRoot: string): void {
	settings.delete(resolve(projectRoot));
}

/** The workspace implementation for a project: worktrees unless it is configured for clones. */
export function createRunWorkspace(projectRoot: string): RunWorkspace {
	const setting = settings.get(resolve(projectRoot));
	if (setting?.kind === "clone" && setting.clone) {
		return new CloneRunWorkspace(resolve(projectRoot), setting.clone);
	}
	return new WorktreeRunWorkspace(projectRoot);
}

/** What a run row says about where its workspace is. */
export interface RunWorkspaceFacts {
	workspaceKind?: RunWorkspaceKind | null;
	worktreePath?: string | null;
}

/**
 * What a run's workspace really is: the kind recorded at launch, else its
 * location. Never the project's current setting, which can change while a run
 * is live or waiting to be finalized.
 */
export function runWorkspaceKind(
	projectRoot: string,
	run: RunWorkspaceFacts,
): RunWorkspaceKind {
	if (run.workspaceKind) return run.workspaceKind;
	if (run.worktreePath) {
		return isRunWorkspacePath(run.worktreePath) ? "clone" : "worktree";
	}
	return settings.get(resolve(projectRoot))?.kind ?? "worktree";
}

/** The implementation that owns this run's workspace. Refuses rather than guess. */
export function workspaceForRun(
	projectRoot: string,
	run: RunWorkspaceFacts,
): RunWorkspace {
	if (runWorkspaceKind(projectRoot, run) === "worktree") {
		return new WorktreeRunWorkspace(projectRoot);
	}
	const clone = settings.get(resolve(projectRoot))?.clone;
	if (!clone) {
		throw new Error(
			`run workspace ${run.worktreePath ?? "(unknown)"} is a clone, but this project has no clone settings`,
		);
	}
	return new CloneRunWorkspace(resolve(projectRoot), clone);
}

/**
 * The disposable verification clones for a project, or null when it runs on
 * worktrees (verification then happens in the run's own worktree, as before).
 * With a run, the answer follows that run's workspace, not the project setting.
 */
export function createVerifierClones(
	projectRoot: string,
	run?: RunWorkspaceFacts,
): VerifierClones | null {
	const setting = settings.get(resolve(projectRoot));
	if (!setting?.clone) return null;
	const kind = run ? runWorkspaceKind(projectRoot, run) : setting.kind;
	if (kind !== "clone") return null;
	return new VerifierClones({
		workspaceRoot: setting.clone.workspaceRoot,
		primaryRoot: resolve(projectRoot),
		...(setting.clone.caches ? { caches: setting.clone.caches } : {}),
		...(setting.clone.gitBin ? { gitBin: setting.clone.gitBin } : {}),
		...(setting.clone.log ? { log: setting.clone.log } : {}),
	});
}

/**
 * Options for rebasing a clone run in a host-owned scratch clone, or null when
 * the project runs on worktrees (the run rebases in its own worktree).
 */
export function rebaseCloneOptions(
	projectRoot: string,
): RebaseCloneOptions | null {
	const setting = settings.get(resolve(projectRoot));
	// Offered whatever the current setting: the merge queue uses it only for a
	// job that has a quarantine ref, which only a clone run can have.
	if (!setting?.clone) return null;
	return {
		workspaceRoot: setting.clone.workspaceRoot,
		primaryRoot: resolve(projectRoot),
		...(setting.clone.scratchRoot
			? { scratchRoot: setting.clone.scratchRoot }
			: {}),
		...(setting.clone.gitBin ? { gitBin: setting.clone.gitBin } : {}),
	};
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
