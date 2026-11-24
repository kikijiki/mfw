import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CheckRunner } from "../../src/containment/check-runner.ts";
import { runProc } from "../../src/proc.ts";
import type { CloneRunWorkspace } from "../../src/run-workspace/clone-impl.ts";
import {
	clearRunWorkspace,
	configureRunWorkspace,
	createRunWorkspace,
} from "../../src/run-workspace/factory.ts";
import type { RunWorkspaceHandle } from "../../src/run-workspace/run-workspace.ts";
import { hostFinalSnapshot } from "./host-snapshot.ts";

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

/**
 * Register run and check clones for a project, as `attachProject` would. The
 * agent side is a test: no process is ever live, and the end-of-run snapshot
 * is the real WIP helper run on the host (`host-snapshot.ts`). The result
 * removes them again.
 */
export function useCheckClones(
	projectRoot: string,
	opts: { checkRunner?: CheckRunner; workspaceRoot?: string } = {},
): () => Promise<void> {
	const workspaces =
		opts.workspaceRoot ?? mkdtempSync(join(tmpdir(), "mfw-check-clones-"));
	configureRunWorkspace(projectRoot, {
		workspaceRoot: workspaces,
		checkRunner: opts.checkRunner ?? cloneCheckRunner,
		assertProcessesDead: () => {},
		finalSnapshot: hostFinalSnapshot({
			workspaceRoot: workspaces,
			runDirOf: (runId) => join(workspaces, runId),
		}),
	});
	return async () => {
		clearRunWorkspace(projectRoot);
		await rm(workspaces, { recursive: true, force: true });
	};
}

/** Seed a run's clone of `base` in an attached (or `useCheckClones`) project. */
export function seedRun(
	projectRoot: string,
	runId: string,
	base = "main",
): Promise<RunWorkspaceHandle> {
	return createRunWorkspace(projectRoot).seed(runId, base);
}

/**
 * Git in a run's clone the way its agent sees it: the sandbox's `GIT_DIR`.
 * This is the agent's side, so it is not the host's hardened `git()`.
 */
export async function agentGit(
	tree: string,
	args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(
		[
			"git",
			"-c",
			"user.name=agent",
			"-c",
			"user.email=agent@test.invalid",
			...args,
		],
		{
			cwd: tree,
			env: {
				...process.env,
				GIT_DIR: join(dirname(tree), "git"),
				GIT_WORK_TREE: tree,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { exitCode, stdout: stdout.trim(), stderr };
}

/** What the agent does: write `files` in its tree and, unless `commit` is false, commit them. */
export async function agentWork(
	tree: string,
	files: Record<string, string>,
	opts: { commit?: boolean; message?: string } = {},
): Promise<void> {
	for (const [path, body] of Object.entries(files)) {
		await writeFile(join(tree, path), body);
	}
	if (opts.commit === false) return;
	await agentGit(tree, ["add", "-A"]);
	const r = await agentGit(tree, [
		"commit",
		"-q",
		"-m",
		opts.message ?? "agent work",
	]);
	if (r.exitCode !== 0) throw new Error(`agent commit failed: ${r.stderr}`);
}

/** The run ended: import its result as finalize would. */
export function importResult(
	projectRoot: string,
	handle: RunWorkspaceHandle,
): ReturnType<CloneRunWorkspace["fetchResult"]> {
	return createRunWorkspace(projectRoot).fetchResult(handle);
}
