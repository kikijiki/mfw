/**
 * Puts the WIP helper where a sandbox can run it: one transpiled file in the
 * run's host-written `control/`, which the sandbox mounts read-only. The agent
 * therefore cannot change the helper's code on disk, although it shares the
 * helper's uid and can still kill it (the host then recovers, see
 * `CloneRunWorkspace.fetchResult`).
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SANDBOX_PATHS } from "../containment/compile-bwrap.ts";
import { bundleArgs } from "./wip-helper.ts";

export const WIP_HELPER_FILE = "wip-helper.js";

/** The helper as a single script. It imports node builtins only. */
export function wipHelperScript(): string {
	const source = readFileSync(join(import.meta.dir, "wip-helper.ts"), "utf8");
	return new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(
		source,
	);
}

/** The arguments the helper gives `git`; the host's refspecs must name the same refs. */
export const helperBundleArgs = bundleArgs;

/** Write the helper into a host-owned control directory, atomically. */
export function installWipHelper(controlDir: string): void {
	const final = join(controlDir, WIP_HELPER_FILE);
	const staging = `${final}.${process.pid}.tmp`;
	writeFileSync(staging, wipHelperScript(), { mode: 0o444, flag: "w" });
	chmodSync(staging, 0o444);
	renameSync(staging, final);
}

/** The sandbox's entry command: the helper, supervising the agent. */
export function wipSupervisorArgv(
	bun: string,
	runId: string,
	agentArgv: readonly string[],
): string[] {
	return [
		bun,
		"--config=/dev/null",
		"--no-env-file",
		`${SANDBOX_PATHS.runControl}/${WIP_HELPER_FILE}`,
		"exec",
		"--run",
		runId,
		"--control",
		`${SANDBOX_PATHS.runControl}/control.jsonl`,
		"--outbox",
		SANDBOX_PATHS.runOutbox,
		"--",
		...agentArgv,
	];
}
