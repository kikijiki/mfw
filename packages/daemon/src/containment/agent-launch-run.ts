/**
 * The launcher's body: parse the request, run the single launch path, relay
 * stdio. A refusal is one line on stderr and exit 78; the agent never starts.
 */

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import {
	type AgentLaunchDeps,
	type AgentLaunchRequest,
	AgentLaunchRequestSchema,
	launchAgentSandbox,
} from "./agent-launch.ts";

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
 * The longest line relayed to the host-side bridge. The bridge and driver
 * buffer until a newline and run outside the sandbox's memory limit, so an
 * agent writing without newlines could otherwise exhaust the host's memory.
 */
export const MAX_RELAY_LINE_BYTES = 16 * 1024 * 1024;

/** Bytes since the last newline after `chunk`, given the count before it. */
export function openLineBytes(before: number, chunk: Uint8Array): number {
	const newline = chunk.lastIndexOf(0x0a);
	return newline >= 0 ? chunk.length - newline - 1 : before + chunk.length;
}

async function relayOut(
	from: ReadableStream<Uint8Array>,
	to: NodeJS.WriteStream,
	onOverflow: () => void,
): Promise<void> {
	let open = 0;
	for await (const chunk of from) {
		open = openLineBytes(open, chunk);
		if (open > MAX_RELAY_LINE_BYTES) {
			onOverflow();
			return;
		}
		if (!to.write(chunk)) {
			await new Promise<void>((resolve) => to.once("drain", () => resolve()));
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
	let overflowed = false;
	const overflow = () => {
		overflowed = true;
		child.kill("SIGKILL");
	};
	const out = relayOut(child.stdout as never, process.stdout, overflow);
	const err = relayOut(child.stderr as never, process.stderr, overflow);
	const code = await child.exited;
	await Promise.allSettled([out, err]);
	if (overflowed) {
		die(
			`the agent wrote a line over ${MAX_RELAY_LINE_BYTES} bytes and was stopped`,
		);
	}
	process.exit(code);
}
