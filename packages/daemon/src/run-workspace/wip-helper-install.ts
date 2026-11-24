/**
 * Puts the WIP helper where a sandbox can run it: one transpiled file in the
 * run's host-written `control/`, which the sandbox mounts read-only. The agent
 * therefore cannot change the helper's code on disk, although it shares the
 * helper's uid and can still kill it, which costs only live snapshots.
 */
import {
	chmodSync,
	lstatSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SANDBOX_PATHS } from "../containment/compile-bwrap.ts";
import { hostScriptText, WIP_HELPER } from "../containment/host-script.ts";
import { bundleArgs } from "./wip-helper.ts";

export const WIP_HELPER_FILE = "wip-helper.js";

/** The helper as a single script. It imports node builtins only. */
export function wipHelperScript(): string {
	const source = hostScriptText(import.meta.url, WIP_HELPER);
	return new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(
		source,
	);
}

/** The arguments the helper gives `git`; the host's refspecs must name the same refs. */
export const helperBundleArgs = bundleArgs;

/**
 * Make the host-owned control directory hold exactly this helper, atomically.
 * A file that already matches is left alone, so a relaunch changes nothing.
 */
export function installWipHelper(controlDir: string): void {
	const final = join(controlDir, WIP_HELPER_FILE);
	const script = wipHelperScript();
	try {
		const st = lstatSync(final);
		if (
			st.isFile() &&
			(st.mode & 0o777) === 0o444 &&
			readFileSync(final, "utf8") === script
		) {
			return;
		}
	} catch {
		// Not installed yet.
	}
	const staging = `${final}.${process.pid}.tmp`;
	writeFileSync(staging, script, { mode: 0o444, flag: "wx" });
	chmodSync(staging, 0o444);
	renameSync(staging, final);
}

/**
 * The one-shot snapshot command, for a sandbox with no agent in it. The
 * helper's settings are set here because a profile's env may not name them.
 */
export function wipSnapshotArgv(
	sh: string,
	bun: string,
	runId: string,
): string[] {
	return [
		sh,
		"-c",
		'MFW_WIP_RUN_ID="$1" MFW_WIP_OUTBOX="$2" exec "$3" --config=/dev/null --no-env-file "$4" snapshot final',
		"mfw-snapshot",
		runId,
		SANDBOX_PATHS.runOutbox,
		bun,
		`${SANDBOX_PATHS.runControl}/${WIP_HELPER_FILE}`,
	];
}

/**
 * The sandbox's entry command: start the helper in the background, then become
 * the agent. Values travel as positional arguments, never inside the script.
 */
export function wipSupervisorArgv(
	sh: string,
	bun: string,
	runId: string,
	agentArgv: readonly string[],
): string[] {
	const script = [
		'MFW_WIP_RUN_ID="$1" MFW_WIP_CONTROL="$2" MFW_WIP_OUTBOX="$3"',
		'"$4" --config=/dev/null --no-env-file "$5" watch',
		"</dev/null >/dev/null 2>&1 &",
		"shift 5;",
		'exec "$@"',
	].join(" ");
	return [
		sh,
		"-c",
		script,
		"mfw-entry",
		runId,
		`${SANDBOX_PATHS.runControl}/control.jsonl`,
		SANDBOX_PATHS.runOutbox,
		bun,
		`${SANDBOX_PATHS.runControl}/${WIP_HELPER_FILE}`,
		...agentArgv,
	];
}
