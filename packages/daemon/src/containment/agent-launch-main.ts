/**
 * The launcher process: `agent-launch-main.ts <request> -- <agent argv...>`.
 *
 * Runs on the host in place of the agent CLI, so a driver or bridge keeps
 * speaking to it over plain pipes. It runs the single launch path and relays
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
	realLaunchSteps,
} from "./agent-launch.ts";
import { liveCompileHost } from "./agent-launch-host.ts";

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

async function relayOut(
	from: ReadableStream<Uint8Array>,
	to: NodeJS.WriteStream,
): Promise<void> {
	for await (const chunk of from) {
		if (!to.write(chunk)) {
			await new Promise<void>((resolve) => to.once("drain", () => resolve()));
		}
	}
}

async function main(): Promise<void> {
	const [requestPath, separator, ...argv] = process.argv.slice(2);
	if (!requestPath || separator !== "--" || argv.length === 0) {
		die("usage: agent-launch-main <request> -- <agent argv...>");
	}
	let req: AgentLaunchRequest;
	try {
		req = readRequest(requestPath);
	} catch (err) {
		die(`bad launch request: ${(err as Error).message}`);
	}
	const handle = await openProjectDb(req.stateDir);
	const deps: AgentLaunchDeps = {
		...realLaunchSteps,
		compileHost: liveCompileHost,
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
	const out = relayOut(child.stdout as never, process.stdout);
	const err = relayOut(child.stderr as never, process.stderr);
	const code = await child.exited;
	await Promise.allSettled([out, err]);
	process.exit(code);
}

await main();
