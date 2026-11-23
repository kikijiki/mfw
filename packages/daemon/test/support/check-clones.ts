import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckRunner } from "../../src/containment/check-runner.ts";
import { runProc } from "../../src/proc.ts";
import {
	clearRunWorkspace,
	configureRunWorkspace,
} from "../../src/run-workspace/factory.ts";

/**
 * A stand-in for the verifier sandbox, for tests about what the *callers* do
 * with a result. It runs the check in the disposable clone it is given. The
 * real sandbox is exercised by check-sandbox-live and sweep-no-host-exec.
 */
export const cloneCheckRunner: CheckRunner = (req) =>
	runProc(["sh", "-c", req.command], {
		cwd: req.tree,
		timeoutMs: req.timeoutMs,
		maxOutputBytes: req.maxOutputBytes,
		...(req.signal ? { signal: req.signal } : {}),
	});

/** Register check clones for a project. The result removes them again. */
export function useCheckClones(projectRoot: string): () => Promise<void> {
	const workspaces = mkdtempSync(join(tmpdir(), "mfw-check-clones-"));
	configureRunWorkspace(projectRoot, {
		kind: "worktree",
		clone: { workspaceRoot: workspaces, checkRunner: cloneCheckRunner },
	});
	return async () => {
		clearRunWorkspace(projectRoot);
		await rm(workspaces, { recursive: true, force: true });
	};
}
