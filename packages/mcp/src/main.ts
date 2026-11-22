import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildBrainServer } from "./brain-server.ts";
import { makeBrainClient, makeClient } from "./client.ts";
import { buildMcpServer } from "./server.ts";

/**
 * Entry point: an mfw MCP server over stdio (spawn it from any MCP-capable
 * agent). `--brain <sessionId>` serves the project brain's tools instead; the
 * daemon sets MFW_PROJECT and MFW_BRAIN_TURN in the environment, plus
 * MFW_SOCKET and MFW_BRAIN_TOKEN_FILE (the unix socket and the turn's token file).
 */
const args = process.argv.slice(2);
const at = args.indexOf("--brain");
const server =
	at >= 0
		? buildBrainServer(makeBrainClient(), {
				sessionId: args[at + 1] ?? process.env.MFW_BRAIN_SESSION ?? "",
				project: process.env.MFW_PROJECT ?? "",
				turnRunId: process.env.MFW_BRAIN_TURN ?? "",
			})
		: buildMcpServer(makeClient());
await server.connect(new StdioServerTransport());
