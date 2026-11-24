import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FinalSnapshot } from "../../src/run-workspace/clone-impl.ts";
import {
	configureRunWorkspace,
	runWorkspaceOptions,
} from "../../src/run-workspace/factory.ts";
import { snapshotWip, writeAck } from "../../src/run-workspace/wip-helper.ts";

/**
 * A stand-in for the sandboxed end-of-run snapshot, for tests whose scripted
 * agents run without a sandbox. It runs the real WIP helper, in this process,
 * on the fixture's clone: what the snapshot sandbox does in production
 * (`wip-snapshot.ts`), minus the sandbox. The host import that follows is the
 * real one. The sandboxed path is covered by clone-wip-e2e.
 */
export function hostFinalSnapshot(opts: {
	workspaceRoot: string;
	runDirOf: (runId: string) => string;
}): FinalSnapshot {
	const dirOf = (runId: string) => join(opts.workspaceRoot, runId);
	return {
		available: (runId) => existsSync(join(dirOf(runId), "git")),
		run: async (runId) => {
			const outbox = join(opts.runDirOf(runId), "outbox");
			mkdirSync(outbox, { recursive: true, mode: 0o700 });
			const env = {
				runId,
				gitDir: join(dirOf(runId), "git"),
				workTree: join(dirOf(runId), "tree"),
				outbox,
			};
			const ack = await snapshotWip(env, "final");
			writeAck(outbox, ack);
			return ack.ok ? "ok" : "failed";
		},
	};
}

/**
 * Swap an attached project's end-of-run snapshot for `hostFinalSnapshot`.
 * Call after `attachProject`/`boot`, which register the sandboxed one.
 */
export function useHostSnapshots(projectRoot: string): void {
	const options = runWorkspaceOptions(projectRoot);
	if (!options?.runDirOf) {
		throw new Error(`project ${projectRoot} is not attached`);
	}
	configureRunWorkspace(projectRoot, {
		...options,
		finalSnapshot: hostFinalSnapshot({
			workspaceRoot: options.workspaceRoot,
			runDirOf: options.runDirOf,
		}),
	});
}

/** The clone dir around a run's tree path (`<root>/<runId>/tree`). */
export function cloneDirOf(treePath: string): string {
	return dirname(treePath);
}
