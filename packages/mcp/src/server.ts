import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MfwClient } from "./client.ts";
import { mcpTools } from "./tools.ts";

const STATUS = [
	"backlog",
	"ready",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
];

// Plain JSON-Schema tool definitions (avoids tying the MCP SDK's bundled zod to
// our zod). Inputs are re-validated by the daemon's tRPC layer (one source of truth).
const TASK_TYPE = ["implementation", "spike", "epic", "maintenance"];
const PRIORITY = ["critical", "high", "medium", "low"];
const SIZE = ["xs", "s", "m", "l", "xl"];

const project = { type: "string", description: "Project name." };

// Loosely typed here; the daemon's VerificationPlanSchema is authoritative.
const verification = {
	type: "object",
	description:
		'Optional task-specific verification checks. They augment project merge checks and never replace them: {"verifier":"deterministic","checks":[...]}.',
};
const criteria = {
	type: "array",
	items: {
		type: "object",
		properties: {
			text: { type: "string" },
			checked: { type: "boolean" },
		},
		required: ["text"],
	},
};

const TOOLS = [
	{
		name: "list_tasks",
		description: "List a project's tasks, optionally filtered by status.",
		inputSchema: {
			type: "object",
			properties: { project, status: { type: "string", enum: STATUS } },
			required: ["project"],
		},
	},
	{
		name: "get_task",
		description: "Read one task, with its dependencies and criteria.",
		inputSchema: {
			type: "object",
			properties: { project, id: { type: "string" } },
			required: ["project", "id"],
		},
	},
	{
		name: "graph",
		description: "The project's dependency DAG (nodes and edges).",
		inputSchema: {
			type: "object",
			properties: { project },
			required: ["project"],
		},
	},
	{
		name: "create_task",
		description:
			"Create a task in backlog. Ids are assigned by the server; never invent one.",
		inputSchema: {
			type: "object",
			properties: {
				project,
				title: { type: "string" },
				body: { type: "string" },
				type: { type: "string", enum: TASK_TYPE },
				priority: { type: "string", enum: PRIORITY },
				size: { type: "string", enum: SIZE },
				labels: { type: "array", items: { type: "string" } },
				dependsOn: { type: "array", items: { type: "string" } },
				requiresResources: { type: "array", items: { type: "string" } },
				verification,
				criteria,
			},
			required: ["project", "title"],
		},
	},
	{
		name: "edit_task",
		description:
			"Edit a task's content. Pass baseRev (the task's contentRev as you last read it) so a concurrent human edit fails with CONFLICT instead of being overwritten.",
		inputSchema: {
			type: "object",
			properties: {
				project,
				id: { type: "string" },
				baseRev: { type: "number" },
				patch: {
					type: "object",
					properties: {
						title: { type: "string" },
						body: { type: "string" },
						type: { type: "string", enum: TASK_TYPE },
						priority: { type: "string", enum: PRIORITY },
						size: { type: "string", enum: SIZE },
						labels: { type: "array", items: { type: "string" } },
						dependsOn: { type: "array", items: { type: "string" } },
						requiresResources: { type: "array", items: { type: "string" } },
					},
				},
			},
			required: ["project", "id", "patch"],
		},
	},
	{
		name: "move_task",
		description: "Move a task to another status, with a reason.",
		inputSchema: {
			type: "object",
			properties: {
				project,
				id: { type: "string" },
				to: { type: "string", enum: STATUS },
				reason: { type: "string" },
			},
			required: ["project", "id", "to"],
		},
	},
	{
		name: "inbox",
		description:
			"Everything needing a human right now, across every project: clarify questions, review-ready work, blocked tasks, parked merges, failed runs.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "task_trace",
		description:
			"Why a task is where it is: its runs, the brain decisions about it with their reasons, and its audit events.",
		inputSchema: {
			type: "object",
			properties: { project, taskId: { type: "string" } },
			required: ["project", "taskId"],
		},
	},
	{
		name: "health",
		description:
			"Daemon health: loop liveness, run and task counts, merge queue depth, spend.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "list_runs",
		description: "Runs for a project, newest first; optionally for one task.",
		inputSchema: {
			type: "object",
			properties: { project, taskId: { type: "string" } },
			required: ["project"],
		},
	},
	{
		name: "run_entries",
		description:
			"A run's parsed transcript from a byte offset (messages, tool calls, usage, errors).",
		inputSchema: {
			type: "object",
			properties: {
				project,
				runId: { type: "string" },
				offset: { type: "number" },
			},
			required: ["project", "runId"],
		},
	},
] as const;

/** Build an MCP server exposing mfw task tools backed by `client`. */
export function buildMcpServer(client: MfwClient): Server {
	const server = new Server(
		{ name: "mfw", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);
	const tools = mcpTools(client) as unknown as Record<
		string,
		(a: Record<string, unknown>) => Promise<unknown>
	>;

	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: TOOLS as unknown as { name: string }[],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const fn = tools[req.params.name];
		if (!fn) throw new Error(`unknown tool: ${req.params.name}`);
		const result = await fn(
			(req.params.arguments ?? {}) as Record<string, unknown>,
		);
		return {
			content: [
				{ type: "text" as const, text: JSON.stringify(result, null, 2) },
			],
		};
	});
	return server;
}
