import { resolve } from "node:path";
import { registerRunWorkspaceRoot } from "../host-git/legacy-guard.ts";
import { CloneRunWorkspace, type CloneWorkspaceOptions } from "./clone-impl.ts";
import type { RebaseCloneOptions } from "./rebase-clone.ts";
import type { RunWorkspaceHandle } from "./run-workspace.ts";
import { VerifierClones } from "./verifier-clone.ts";

/**
 * Every run works in a private clone under `$MFW_HOME/workspaces`
 * (`clone-impl.ts`). Checks run only in disposable host-owned clones, in the
 * attested no-network verifier roles: the host never executes a candidate's
 * code. What is still open before real projects go green (P8 dev shells, the
 * death proof under a real systemd scope, real CLIs on NixOS and Ubuntu) is
 * tracked in the plan, not here.
 */

const settings = new Map<string, CloneWorkspaceOptions>();

/**
 * Register a project's clone settings (workspace root, liveness proof, check
 * runner). Called when the project attaches; every `createRunWorkspace` call
 * for that root then uses them, so callers do not each read config.
 */
export function configureRunWorkspace(
	projectRoot: string,
	options: CloneWorkspaceOptions,
): void {
	registerRunWorkspaceRoot(options.workspaceRoot);
	settings.set(resolve(projectRoot), options);
}

/** Forget a project's settings (detach, and test cleanup). */
export function clearRunWorkspace(projectRoot: string): void {
	settings.delete(resolve(projectRoot));
}

/** The settings a project attached with, or null before it attaches. */
export function runWorkspaceOptions(
	projectRoot: string,
): CloneWorkspaceOptions | null {
	return settings.get(resolve(projectRoot)) ?? null;
}

function required(projectRoot: string): CloneWorkspaceOptions {
	const options = settings.get(resolve(projectRoot));
	if (!options) {
		throw new Error(
			`project ${projectRoot} has no run workspace settings: attach it first`,
		);
	}
	return options;
}

/** The project's run workspaces. Throws for a project that never attached. */
export function createRunWorkspace(projectRoot: string): CloneRunWorkspace {
	return new CloneRunWorkspace(resolve(projectRoot), required(projectRoot));
}

/** Where a project's clones live, or null before it attaches. */
export function workspaceRootOf(projectRoot: string): string | null {
	return settings.get(resolve(projectRoot))?.workspaceRoot ?? null;
}

/**
 * The disposable verification clones for a project: a run's DoD checks, the
 * merge queue's and maintenance's all run in these, never in a run's
 * workspace or on the host. Null before the project attaches.
 */
export function createCheckClones(projectRoot: string): VerifierClones | null {
	const clone = settings.get(resolve(projectRoot));
	if (!clone) return null;
	return new VerifierClones({
		workspaceRoot: clone.workspaceRoot,
		primaryRoot: resolve(projectRoot),
		...(clone.caches ? { caches: clone.caches } : {}),
		...(clone.gitBin ? { gitBin: clone.gitBin } : {}),
		...(clone.log ? { log: clone.log } : {}),
		...(clone.checkRunner ? { checkRunner: clone.checkRunner } : {}),
		...(clone.prepareTree ? { prepareTree: clone.prepareTree } : {}),
	});
}

/** Options for rebasing a run in a host-owned scratch clone, or null before the project attaches. */
export function rebaseCloneOptions(
	projectRoot: string,
): RebaseCloneOptions | null {
	const clone = settings.get(resolve(projectRoot));
	if (!clone) return null;
	return {
		workspaceRoot: clone.workspaceRoot,
		primaryRoot: resolve(projectRoot),
		...(clone.scratchRoot ? { scratchRoot: clone.scratchRoot } : {}),
		...(clone.gitBin ? { gitBin: clone.gitBin } : {}),
	};
}

/** The create/remove pair an execution target uses; tests inject their own. */
export interface WorkspacePort {
	create(runId: string, base?: string): Promise<RunWorkspaceHandle>;
	remove(handle: RunWorkspaceHandle): Promise<void>;
}

/** The project's own port, resolved per call: a target may be built before the project attaches. */
export function projectWorkspacePort(projectRoot: string): WorkspacePort {
	return {
		create: (runId, base) => createRunWorkspace(projectRoot).seed(runId, base),
		remove: (handle) => createRunWorkspace(projectRoot).remove(handle),
	};
}

/**
 * The newest work the host imported for the run at `path` (its WIP snapshot
 * when that builds on the branch tip), or null: none yet, or the project
 * never attached.
 */
export async function newestImportedWork(
	projectRoot: string,
	path: string,
): Promise<string | null> {
	const options = settings.get(resolve(projectRoot));
	if (!options) return null;
	return new CloneRunWorkspace(resolve(projectRoot), options)
		.newestWorkOf({ path })
		.catch(() => null);
}
