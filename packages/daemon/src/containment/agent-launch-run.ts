/**
 * The launcher's body: parse the request, run the single launch path, relay
 * stdio. A refusal is one line on stderr and exit 78; the agent never starts.
 */

import {
	closeSync,
	constants,
	lstatSync,
	openSync,
	readFileSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import {
	type AgentLaunchDeps,
	type AgentLaunchRequest,
	AgentLaunchRequestSchema,
	launchAgentSandbox,
} from "./agent-launch.ts";
import { RUN_CONTROL_DIR } from "./run-dir.ts";

const REFUSED = 78;
const MAX_REQUEST_BYTES = 256 * 1024;

function die(message: string): never {
	process.stderr.write(`mfw sandbox refused: ${message}\n`);
	process.exit(REFUSED);
}

/** The request must be a private regular file of ours, in a private directory. */
function readRequest(path: string): AgentLaunchRequest {
	const uid = process.getuid?.();
	const st = lstatSync(path);
	const dir = lstatSync(join(path, ".."));
	if (
		!st.isFile() ||
		st.uid !== uid ||
		st.size > MAX_REQUEST_BYTES ||
		(st.mode & 0o077) !== 0 ||
		!dir.isDirectory() ||
		dir.uid !== uid ||
		(dir.mode & 0o077) !== 0
	) {
		throw new Error("the launch request is not a private file");
	}
	return AgentLaunchRequestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

async function relayStdin(sink: {
	write(chunk: Uint8Array): unknown;
	flush?(): unknown;
	end(): unknown;
}): Promise<void> {
	try {
		for await (const chunk of Bun.stdin.stream()) {
			await sink.write(chunk);
			await sink.flush?.();
		}
	} catch {
		// The child closed its stdin; there is nobody left to write to.
	}
	try {
		await sink.end();
	} catch {}
}

/**
 * Limits on what an agent can push through the host. The launcher, bridge and
 * driver run outside the sandbox's memory limit and each buffers up to one
 * line, so the line cap is what bounds their memory. They are not under a
 * cgroup of their own: `ulimit -v` breaks bun, which reserves far more address
 * space than it uses, and a host without a user manager has no scope to give.
 */
export const MAX_RELAY_LINE_BYTES = 1024 * 1024;

/** What one run may send to the host in total, across relaunches of its CLI. */
export const MAX_RUN_OUTPUT_BYTES = 512 * 1024 * 1024;

/** How often the running total reaches the disk. */
const OUTPUT_SAVE_EVERY_BYTES = 1024 * 1024;

/** Recorded as the run's exit, so it settles as a watchdog kill. */
export const OUTPUT_KILL_REASON = "watchdog-output";

/** Bytes since the last newline after `chunk`, given the count before it. */
export function openLineBytes(before: number, chunk: Uint8Array): number {
	const newline = chunk.lastIndexOf(0x0a);
	return newline >= 0 ? chunk.length - newline - 1 : before + chunk.length;
}

/** The run's output total, kept in the host-only run root. */
class OutputBudget {
	private readonly path: string;
	private total: number;
	private saved: number;

	constructor(
		runDir: string,
		readonly max: number,
	) {
		this.path = join(runDir, "relay-bytes");
		let start = 0;
		try {
			const value = Number(readFileSync(this.path, "utf8").trim());
			if (Number.isSafeInteger(value) && value > 0) start = value;
		} catch {
			// No earlier launch in this run.
		}
		this.total = start;
		this.saved = start;
	}

	/** False once the run is over its budget. */
	add(bytes: number): boolean {
		this.total += bytes;
		if (this.total - this.saved >= OUTPUT_SAVE_EVERY_BYTES) this.save();
		return this.total <= this.max;
	}

	save(): void {
		this.saved = this.total;
		writeFileSync(this.path, String(this.total), { mode: 0o600 });
	}
}

type OutputStop = "line" | "budget";

async function relayOut(
	from: ReadableStream<Uint8Array>,
	to: NodeJS.WriteStream,
	budget: OutputBudget,
	onStop: (why: OutputStop) => void,
): Promise<void> {
	let open = 0;
	for await (const chunk of from) {
		open = openLineBytes(open, chunk);
		if (open > MAX_RELAY_LINE_BYTES) {
			onStop("line");
			return;
		}
		if (!budget.add(chunk.length)) {
			onStop("budget");
			return;
		}
		if (!to.write(chunk)) {
			await new Promise<void>((resolve) => to.once("drain", () => resolve()));
		}
	}
}

/**
 * Record the kill where the host reads a run's exit. Exclusive, so a recorded
 * exit is never replaced, and `run.sh` then keeps this one.
 */
function recordOutputKill(requestPath: string, req: AgentLaunchRequest): void {
	for (const path of [
		join(dirname(requestPath), `exit-${req.runId}`),
		join(req.runDir, RUN_CONTROL_DIR, "exit"),
	]) {
		try {
			const fd = openSync(
				path,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_EXCL |
					constants.O_NOFOLLOW,
				0o600,
			);
			try {
				writeSync(fd, `killed:${OUTPUT_KILL_REASON}`);
			} finally {
				closeSync(fd);
			}
		} catch {
			// Already recorded.
		}
	}
}

/** The host-side steps of a launch; only the tests' caged launcher swaps them. */
export type LauncherSteps = Pick<
	AgentLaunchDeps,
	"compileHost" | "attest" | "authorize" | "launch"
>;

/** Run one launch and relay its stdio until the agent exits. Never returns. */
export async function runLauncher(
	args: readonly string[],
	steps: LauncherSteps,
	limits: { maxOutputBytes?: number } = {},
): Promise<void> {
	const [requestPath, separator, ...argv] = args;
	if (!requestPath || separator !== "--" || argv.length === 0) {
		die("usage: agent-launch-main <request> -- <agent argv...>");
	}
	let req: AgentLaunchRequest;
	try {
		req = readRequest(requestPath);
	} catch (err) {
		die(`bad launch request: ${(err as Error).message}`);
	}
	let handle: Awaited<ReturnType<typeof openProjectDb>>;
	try {
		handle = await openProjectDb(req.stateDir);
	} catch (err) {
		die(`cannot open the project database: ${(err as Error).message}`);
	}
	const deps: AgentLaunchDeps = {
		...steps,
		db: handle.db,
		secretValue: (name) => process.env[name],
		warn: (message) => process.stderr.write(`mfw sandbox: ${message}\n`),
	};
	let result: Awaited<ReturnType<typeof launchAgentSandbox>>;
	try {
		result = await launchAgentSandbox(req, argv, deps);
	} catch (err) {
		handle.close();
		die(`launch failed: ${(err as Error).message}`);
	}
	handle.close();
	if (!result.ok) die(`${result.code}: ${result.reason}. Fix: ${result.fix}`);

	const { child } = result;
	for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
		process.on(signal, () => child.kill(signal));
	}
	void relayStdin(child.stdin as never);
	const budget = new OutputBudget(
		req.runDir,
		limits.maxOutputBytes ?? MAX_RUN_OUTPUT_BYTES,
	);
	let stopped: OutputStop | null = null;
	const stop = (why: OutputStop) => {
		stopped ??= why;
		child.kill("SIGKILL");
	};
	const out = relayOut(child.stdout as never, process.stdout, budget, stop);
	const err = relayOut(child.stderr as never, process.stderr, budget, stop);
	const code = await child.exited;
	await Promise.allSettled([out, err]);
	budget.save();
	if (stopped) {
		recordOutputKill(requestPath, req);
		die(
			stopped === "line"
				? `the agent wrote a line over ${MAX_RELAY_LINE_BYTES} bytes and was stopped`
				: `the agent exceeded the run's output budget of ${budget.max} bytes and was stopped`,
		);
	}
	process.exit(code);
}
