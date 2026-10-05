import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeClient } from "./client.ts";
import { buildMcpServer } from "./server.ts";

/** Entry point: an mfw MCP server over stdio (spawn it from any MCP-capable agent). */
const server = buildMcpServer(makeClient());
await server.connect(new StdioServerTransport());
