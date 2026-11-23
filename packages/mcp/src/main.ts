import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildBrainServer } from "./brain-server.ts";
import { makeBrainClient, makeClient } from "./client.ts";
import { resolveMcpToken } from "./credential.ts";
import { buildMcpServer } from "./server.ts";

/**
 * Entry point: an mfw MCP server over stdio (spawn it from any MCP-capable
 * agent). It reaches the server with a scoped API token (see `credential.ts`).
 * `--brain <sessionId>` serves the project brain's tools instead; the daemon
 * sets MFW_PROJECT and MFW_BRAIN_TURN in the environment, plus MFW_SOCKET and
 * MFW_BRAIN_TOKEN_FILE (the unix socket and the turn's token file). A brain
 * turn never reads an API token.
 */
const args = process.argv.slice(2);
const at = args.indexOf("--brain");

function ownerClient() {
	try {
		const token = resolveMcpToken(args, process.env);
		if (!token)
			console.error(
				process.env.MFW_URL
					? "mfw mcp: no API token for this MFW_URL, so the server will refuse calls. The stored token is used only for the local default; pass --token-file or MFW_TOKEN."
					: "mfw mcp: no API token, so the server will refuse calls. Create one on the host: mfw auth token create --name mcp --scope board:read --write-file",
			);
		return makeClient(undefined, token);
	} catch (e) {
		console.error(`mfw mcp: ${(e as Error).message}`);
		process.exit(2);
	}
}

const server =
	at >= 0
		? buildBrainServer(makeBrainClient(), {
				sessionId: args[at + 1] ?? process.env.MFW_BRAIN_SESSION ?? "",
				project: process.env.MFW_PROJECT ?? "",
				turnRunId: process.env.MFW_BRAIN_TURN ?? "",
			})
		: buildMcpServer(ownerClient());
await server.connect(new StdioServerTransport());
