/**
 * The launcher process: `agent-launch-main.ts <request> -- <agent argv...>`.
 *
 * Runs on the host in place of the agent CLI, so a driver or bridge keeps
 * speaking to it over plain pipes. It runs the single launch path and relays
 * stdio. A refusal is one line on stderr and exit 78; the agent never starts.
 */

import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import { requireHostTool } from "../sandbox.ts";
import {
	type AgentLaunchDeps,
	type AgentLaunchRequest,
	AgentLaunchRequestSchema,
	launchAgentSandbox,
	realLaunchSteps,
} from "./agent-launch.ts";
import { TEMPORARY_FLEET_WRITABLE } from "./agent-profile.ts";
import type { CompileHost } from "./compile-bwrap.ts";
import {
	detectArch,
	detectBwrap,
	detectSystemdUser,
	detectUserns,
	liveHostReaders,
} from "./host-caps.ts";
import { discoverToolchain } from "./toolchain.ts";

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

const realOrNull = (p: string): string | null => {
	try {
		return realpathSync(p);
	} catch {
		return null;
	}
};

/** The allowlisted directories must exist to be bound; nothing else is touched. */
function ensureFleetDirs(req: AgentLaunchRequest): void {
	const fleet = join(req.mfwHome, "agents", req.cli);
	if (realOrNull(fleet) !== fleet) return;
	for (const rel of TEMPORARY_FLEET_WRITABLE[req.cli]) {
		mkdirSync(join(fleet, rel), { recursive: true, mode: 0o700 });
	}
}

async function liveCompileHost(
	req: AgentLaunchRequest,
	binaries: readonly string[],
	allowedRoots: readonly string[],
): Promise<CompileHost> {
	ensureFleetDirs(req);
	const bwrapPath = requireHostTool("bwrap");
	const readers = liveHostReaders();
	const [userns, bwrap, systemd] = await Promise.all([
		detectUserns(readers),
		detectBwrap(readers, bwrapPath),
		detectSystemdUser(readers),
	]);
	const home = homedir();
	return {
		caps: { userns, bwrap, systemd, arch: detectArch(readers) },
		bwrapPath,
		envPath: requireHostTool("env"),
		systemdRunPath: requireHostTool("systemd-run"),
		toolchain: discoverToolchain({
			home,
			binaries,
			path: process.env.PATH ?? "",
		}),
		home,
		mfwHome: req.mfwHome,
		projectDbDirs: [req.stateDir],
		allowedRoots,
		realpath: realOrNull,
	};
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
