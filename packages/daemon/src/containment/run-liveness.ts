/**
 * Proof that a run's processes are dead. A tmux session that is gone proves
 * little: `no server running` also happens when the socket is lost while the
 * sandbox lives, and `kill-session` returns before the launcher has finished.
 *
 * The launcher records itself before it starts anything, then the sandbox
 * process, each as (pid, kernel start time) so a reused pid is not mistaken
 * for it. The sandbox dies with its launcher (`--die-with-parent`) and every
 * process in it dies with the sandbox's pid namespace. The record sits in the
 * host-only run root, which no sandbox binds.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RECORD_FILE = "launch-procs.jsonl";
const DEFAULT_WAIT_MS = 5_000;
const POLL_MS = 50;

export function runProcessRecordPath(runDir: string): string {
	return join(runDir, RECORD_FILE);
}

/** A process's kernel start time, or null when it is gone or a zombie. */
export function processStartTime(pid: number): string | null {
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "latin1");
	} catch {
		return null;
	}
	// The command name may hold spaces and parentheses: fields follow the last `)`.
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const state = fields[0];
	if (state === "Z" || state === "X") return null;
	return fields[19] ?? null;
}

export function recordRunProcess(runDir: string, pid: number): void {
	const start = processStartTime(pid);
	// A process that already exited needs no record.
	if (start === null) return;
	appendFileSync(
		runProcessRecordPath(runDir),
		`${JSON.stringify({ pid, start })}\n`,
		{ mode: 0o600 },
	);
}

/** The recorded processes still running. Throws on a record it cannot read. */
export function liveRunProcesses(runDir: string): number[] {
	let text: string;
	try {
		text = readFileSync(runProcessRecordPath(runDir), "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw e;
	}
	const live: number[] = [];
	for (const line of text.split("\n").filter(Boolean)) {
		const { pid, start } = JSON.parse(line) as { pid: number; start: string };
		if (!Number.isSafeInteger(pid) || typeof start !== "string") {
			throw new Error("malformed run process record");
		}
		if (processStartTime(pid) === start) live.push(pid);
	}
	return live;
}

/**
 * Throws unless the session is positively gone and every recorded process has
 * exited, waiting briefly for a kill that is still landing.
 */
export async function assertRunDead(opts: {
	runId: string;
	runDir: string;
	sessionLiveness: () => Promise<boolean | null>;
	waitMs?: number;
}): Promise<void> {
	if ((await opts.sessionLiveness()) !== false) {
		throw new Error(`run ${opts.runId} is not confirmed stopped`);
	}
	const deadline = Date.now() + (opts.waitMs ?? DEFAULT_WAIT_MS);
	for (;;) {
		const live = liveRunProcesses(opts.runDir);
		if (live.length === 0) return;
		if (Date.now() >= deadline) {
			throw new Error(
				`run ${opts.runId} still has running processes: ${live.join(", ")}`,
			);
		}
		await Bun.sleep(POLL_MS);
	}
}
