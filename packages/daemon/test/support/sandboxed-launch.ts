import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import type { LaunchSpec } from "../../src/agent-host.ts";

/**
 * The layout every launch needs now that each one is sandboxed: a project
 * state dir with its database, the run dir under `runs/`, a fleet home and a
 * provider with a sandbox profile. Tests that swap the host driver for a
 * scripted one still take the real launch path up to that driver; no agent
 * CLI and no sandbox child ever starts.
 */
export async function sandboxedLaunchLayout(
	base: string,
	runId: string,
): Promise<
	Pick<
		LaunchSpec,
		"runDir" | "projectRoot" | "isolation" | "providerId" | "runKind"
	> & { mfwHome: string; stateDir: string }
> {
	const projectRoot = join(base, "project");
	const stateDir = join(projectRoot, ".mfw");
	const runDir = join(stateDir, "runs", runId);
	const mfwHome = join(base, "mfw-home");
	await mkdir(runDir, { recursive: true });
	await mkdir(join(mfwHome, "agents", "claude"), { recursive: true });
	(await openProjectDb(stateDir)).close();
	return {
		runDir,
		projectRoot,
		stateDir,
		mfwHome,
		isolation: { mode: "bwrap", hidePaths: [mfwHome], mfwHome },
		providerId: "claude-cli",
		runKind: "task",
	};
}

/** A whole launch spec over `sandboxedLaunchLayout`, minus the driver. */
export async function sandboxedSpec(
	base: string,
	runId: string,
	cwd: string,
): Promise<Omit<LaunchSpec, "driverScript">> {
	const {
		mfwHome: _home,
		stateDir: _state,
		...layout
	} = await sandboxedLaunchLayout(base, runId);
	return {
		runId,
		cwd,
		agentArgv: ["true"],
		env: {},
		steer: false,
		approvalMode: "interactive",
		...layout,
	};
}
