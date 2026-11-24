/**
 * What a brain turn needs inside its sandbox (design "Role profiles": read-only,
 * plus its socket and LLM egress).
 *
 * The MCP server is a child of the harness, so it runs in the sandbox too. The
 * source tree is not bound, so it is bundled into the run's read-only control
 * directory. It reaches the daemon only through this turn's socket directory.
 *
 * Only the turn's transcript survives to the next turn (brain-transcript.ts).
 */

import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexMcpArgs, mcpMainScript } from "../agents/adapter.ts";
import {
	BRAIN_SOCKET_FILE,
	BRAIN_TOKEN_FILE,
} from "../brain-runtime/brain-socket.ts";
import {
	type BrainMcpServer,
	readBrainTurnLaunch,
} from "../brain-runtime/turn-run.ts";
import { HOST_BUN_FLAGS } from "./agent-launch-argv.ts";
import type { FleetCli } from "./agent-profile.ts";
import { brainTranscriptStore } from "./brain-transcript.ts";
import { SANDBOX_PATHS } from "./compile-bwrap.ts";
import { hostScriptText, MCP_MAIN, runsHostEntries } from "./host-script.ts";
import { runDirLayout } from "./run-dir.ts";

const MCP_BUNDLE = "mfw-mcp.js";
const MCP_CONFIG = "mcp.json";

export class BrainLaunchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BrainLaunchError";
	}
}

export interface BrainSandbox {
	agentArgv: string[];
	providerArgv: string[];
	brainSocketDir: string;
	/** Where this session's transcript is kept between turns. Host-only. */
	transcriptStore: string;
}

/** The same MCP server, as the sandbox must start it. */
export function sandboxMcpServer(server: BrainMcpServer): BrainMcpServer {
	const session = server.env.MFW_BRAIN_SESSION ?? "";
	return {
		name: server.name,
		command: "bun",
		args: [
			...HOST_BUN_FLAGS,
			"run",
			`${SANDBOX_PATHS.runControl}/${MCP_BUNDLE}`,
			"--brain",
			session,
		],
		env: {
			...server.env,
			MFW_SOCKET: `${SANDBOX_PATHS.brain}/${BRAIN_SOCKET_FILE}`,
			MFW_BRAIN_TOKEN_FILE: `${SANDBOX_PATHS.brain}/${BRAIN_TOKEN_FILE}`,
		},
	};
}

/** Point a harness command line at the sandbox's MCP config. */
export function rewriteBrainArgv(
	argv: readonly string[],
	server: BrainMcpServer,
): string[] {
	const out: string[] = [];
	const prefix = `mcp_servers.${server.name}.`;
	let codexDone = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--mcp-config") {
			out.push(arg, `${SANDBOX_PATHS.runControl}/${MCP_CONFIG}`);
			i++;
		} else if (arg === "-c" && argv[i + 1]?.startsWith(prefix)) {
			if (!codexDone) out.push(...codexMcpArgs(server));
			codexDone = true;
			i++;
		} else {
			out.push(arg);
		}
	}
	return out;
}

/** The MCP server as one script. A compiled install carries it prebuilt in `mfw`. */
async function mcpBundleText(): Promise<string> {
	if (runsHostEntries(import.meta.url)) {
		try {
			return hostScriptText(import.meta.url, MCP_MAIN);
		} catch (err) {
			throw new BrainLaunchError((err as Error).message);
		}
	}
	const built = await Bun.build({
		entrypoints: [mcpMainScript()],
		target: "bun",
	});
	const output = built.outputs[0];
	if (!built.success || !output) {
		throw new BrainLaunchError("could not bundle the brain's MCP server");
	}
	return output.text();
}

async function bundleMcp(dest: string): Promise<void> {
	const text = await mcpBundleText();
	rmSync(dest, { force: true });
	writeFileSync(dest, text, { mode: 0o444 });
	chmodSync(dest, 0o444);
}

export async function prepareBrainSandbox(input: {
	runDir: string;
	mfwHome: string;
	cli: FleetCli;
	agentArgv: readonly string[];
	providerArgv: readonly string[];
}): Promise<BrainSandbox> {
	const launch = await readBrainTurnLaunch(input.runDir);
	const socket = launch.mcp.env.MFW_SOCKET;
	if (!socket || !launch.mcp.env.MFW_BRAIN_TOKEN_FILE) {
		throw new BrainLaunchError(
			"a sandboxed brain turn needs the brain socket, and this one has none: unset MFW_BRAIN_TCP and mcp.url",
		);
	}
	const session = launch.mcp.env.MFW_BRAIN_SESSION ?? "";
	let transcriptStore: string;
	try {
		transcriptStore = brainTranscriptStore(input.mfwHome, session, input.cli);
	} catch (err) {
		throw new BrainLaunchError((err as Error).message);
	}
	const { control } = runDirLayout(input.runDir);
	await bundleMcp(join(control, MCP_BUNDLE));
	const server = sandboxMcpServer(launch.mcp);
	const config = join(control, MCP_CONFIG);
	rmSync(config, { force: true });
	writeFileSync(
		config,
		`${JSON.stringify({ mcpServers: { [server.name]: { command: server.command, args: server.args, env: server.env } } }, null, "\t")}\n`,
		{ mode: 0o444 },
	);
	return {
		agentArgv: rewriteBrainArgv(input.agentArgv, server),
		providerArgv: rewriteBrainArgv(input.providerArgv, server),
		brainSocketDir: dirname(socket),
		transcriptStore,
	};
}
