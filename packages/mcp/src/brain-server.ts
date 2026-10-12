import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MfwClient } from "./client.ts";

/**
 * `mfw-mcp --brain <sessionId>`: the project brain's tools. Every call goes to
 * the daemon's `brain.*` procedures; this process holds no state of its own
 * and no credential. Read tools are queries, act tools are mutations that the
 * daemon validates against the real invariants, records, and executes (a
 * spawn is accepted for the scheduler; the others apply before they return).
 */

const rationale = {
	type: "string",
	maxLength: 1000,
	description: "Why this, now (required, at most 1,000 characters).",
};
const alternatives = {
	type: "array",
	description: "What else you considered: {option, why_not}.",
	items: {
		type: "object",
		properties: { option: { type: "string" }, why_not: { type: "string" } },
		required: ["option", "why_not"],
	},
};
const confidence = { type: "string", enum: ["low", "medium", "high"] };

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
	type: "object",
	properties,
	required,
});
const act = (properties: Record<string, unknown>, required: string[]) =>
	obj({ rationale, alternatives, confidence, ...properties }, [
		"rationale",
		...required,
	]);
const str = { type: "string" };
const strs = { type: "array", items: { type: "string" } };

interface ToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	kind: "read" | "act";
}

const taskSpec = {
	type: "object",
	description:
		"{ref?, title, body?, spec?, type, size, priority?, parent?, depends_on?, owns?, verification?, acceptance?, requires_resources?, execution_target?, status?}. `ref` is a lowercase local name; parent and depends_on may name another task of the same call by its ref. New owns must be ordered (depends_on) against live work that overlaps it.",
};

export const BRAIN_TOOLS: ToolDef[] = [
	{
		kind: "read",
		name: "board",
		description:
			"Task summaries (id, title, status, parent, depends_on, owns, size, type, priority, labels, rev).",
		inputSchema: obj({
			filter: obj({ status: str, parent: str, type: str, ids: strs }),
			limit: { type: "number" },
		}),
	},
	{
		kind: "read",
		name: "task",
		description:
			"One task in full: body, spec, acceptance, claim, run state, recent runs.",
		inputSchema: obj({ id: str }, ["id"]),
	},
	{
		kind: "read",
		name: "frontier",
		description:
			"The ready tasks, most unblocking first, with provider holds per task.",
		inputSchema: obj({ limit: { type: "number" } }),
	},
	{
		kind: "read",
		name: "runs",
		description: "Worker runs with route, activity and spend.",
		inputSchema: obj({
			filter: obj({ live: { type: "boolean" }, taskId: str }),
			limit: { type: "number" },
		}),
	},
	{
		kind: "read",
		name: "run_report",
		description:
			"Verify results, scope, review verdicts, report, diff stat, cost and native session id of a run.",
		inputSchema: obj({ runId: str }, ["runId"]),
	},
	{
		kind: "read",
		name: "run_log",
		description: "A run's transcript entries (capped), optionally filtered.",
		inputSchema: obj({ runId: str, tail: { type: "number" }, grep: str }, [
			"runId",
		]),
	},
	{
		kind: "read",
		name: "diff",
		description: "A run's diff against its base (capped).",
		inputSchema: obj({ runId: str, path: str, maxBytes: { type: "number" } }, [
			"runId",
		]),
	},
	{
		kind: "read",
		name: "capacity",
		description:
			"Worker slots, provider holds, main red, dispatch pause and recent spend.",
		inputSchema: obj({}),
	},
	{
		kind: "read",
		name: "outcomes",
		description:
			"Attempt outcomes grouped by harness, model, tier, size, type or target.",
		inputSchema: obj({
			groupBy: strs,
			sinceDays: { type: "number" },
			filter: obj({ harness: str, model: str, tier: str, size: str }),
		}),
	},
	{
		kind: "read",
		name: "decisions",
		description: "Your own audit trail, with outcomes and human overrides.",
		inputSchema: obj({
			filter: obj({ taskId: str, kind: str, since: { type: "number" } }),
			limit: { type: "number" },
		}),
	},
	{
		kind: "act",
		name: "create_tasks",
		description:
			"Create up to 20 tasks, all or none. Tasks may name each other by ref. A cycle, an unknown parent or dependency, a rule of the board's hierarchy, or an unordered owns overlap rejects the whole call.",
		inputSchema: act({ tasks: { type: "array", items: taskSpec } }, ["tasks"]),
	},
	{
		kind: "act",
		name: "update_task",
		description:
			"Edit a task under its rev. Pass baseRev as you read it; a stale rev is rejected.",
		inputSchema: act(
			{
				id: str,
				baseRev: { type: "number" },
				patch: { type: "object" },
				override_human_pin: { type: "boolean" },
			},
			["id", "baseRev", "patch"],
		),
	},
	{
		kind: "act",
		name: "reparent",
		description: "Move a task under another parent, or to the top (null).",
		inputSchema: act({ id: str, parent: { type: ["string", "null"] } }, [
			"id",
			"parent",
		]),
	},
	{
		kind: "act",
		name: "split_task",
		description: "Split a task into children.",
		inputSchema: act(
			{
				id: str,
				into: { type: "array", items: taskSpec },
				keep_original: { type: "string", enum: ["archive", "epic"] },
				stop_live: { type: "boolean" },
			},
			["id", "into", "keep_original"],
		),
	},
	{
		kind: "act",
		name: "merge_tasks",
		description: "Merge tasks into one new task; the originals are archived.",
		inputSchema: act({ ids: strs, into: { type: "object" } }, ["ids", "into"]),
	},
	{
		kind: "act",
		name: "set_status",
		description: "Move a task: backlog, ready, blocked, archived or draft.",
		inputSchema: act(
			{
				id: str,
				to: {
					type: "string",
					enum: ["backlog", "ready", "blocked", "archived", "draft"],
				},
				reason: str,
			},
			["id", "to", "reason"],
		),
	},
	{
		kind: "act",
		name: "answer_question",
		description: "Answer a worker's open question.",
		inputSchema: act({ runId: str, answer: str }, ["runId", "answer"]),
	},
	{
		kind: "act",
		name: "spawn",
		description:
			"Start a run on a task. Roles implement, attempt and plan are live (the others are refused with a fix). Role plan is read-only: on a draft it expands the draft, on any other task it plans from your brief; read its output with run_report and apply it with the board tools. Returns accepted with the run id; the scheduler launches it when capacity and admission allow.",
		inputSchema: act(
			{
				taskId: str,
				role: {
					type: "string",
					enum: [
						"implement",
						"attempt",
						"review",
						"verify",
						"spike",
						"research",
						"plan",
						"conflict",
					],
				},
				groupId: str,
				harness: str,
				model: str,
				effort: str,
				target: str,
				worktree: str,
				brief: str,
				maxUsd: { type: "number" },
				key: str,
			},
			["taskId", "role"],
		),
	},
	{
		kind: "act",
		name: "spawn_attempts",
		description: "Start competing attempts of one task (all or none).",
		inputSchema: act(
			{
				taskId: str,
				variants: { type: "array", items: { type: "object" } },
				selection: { type: "string", enum: ["brain", "first_verified"] },
			},
			["taskId", "variants", "selection"],
		),
	},
	{
		kind: "act",
		name: "select_winner",
		description: "Choose the winning attempt of a group.",
		inputSchema: act({ groupId: str, runId: str }, ["runId"]),
	},
	{
		kind: "act",
		name: "request_review",
		description: "Ask for an independent review of a run.",
		inputSchema: act(
			{
				runId: str,
				reviewer: obj({ harness: str, model: str }),
				mode: { type: "string", enum: ["critic", "agent"] },
			},
			["runId", "mode"],
		),
	},
	{
		kind: "act",
		name: "steer",
		description: "Send a message to a live run.",
		inputSchema: act({ runId: str, message: str }, ["runId", "message"]),
	},
	{
		kind: "act",
		name: "stop",
		description: "Stop a live run.",
		inputSchema: act(
			{ runId: str, reason: str, keep_worktree: { type: "boolean" } },
			["runId", "reason"],
		),
	},
	{
		kind: "act",
		name: "pause",
		description: "Hold tasks (or a subtree) from being started.",
		inputSchema: act({ taskIds: strs, subtree: str }, []),
	},
	{
		kind: "act",
		name: "resume",
		description: "Release a pause.",
		inputSchema: act({ taskIds: strs, subtree: str }, []),
	},
	{
		kind: "act",
		name: "notify_human",
		description:
			"Ask a person: credential, product_decision, destructive, outward, brain_stuck, or fyi (5 a day).",
		inputSchema: act(
			{
				kind: {
					type: "string",
					enum: [
						"credential",
						"product_decision",
						"destructive",
						"outward",
						"brain_stuck",
						"fyi",
					],
				},
				title: str,
				body: str,
				blocking: strs,
				options: strs,
			},
			["kind", "title", "body"],
		),
	},
	{
		kind: "act",
		name: "set_budget",
		description: "Lower or reallocate a budget within its human ceiling.",
		inputSchema: act(
			{
				budget: str,
				limitUsd: { type: "number" },
				limitTokens: { type: "number" },
				window: str,
			},
			["budget"],
		),
	},
	{
		kind: "act",
		name: "set_plan",
		description:
			"Write your standing plan (markdown). The latest one is your memory across wakes and rollovers.",
		inputSchema: obj({ markdown: str }, ["markdown"]),
	},
	{
		kind: "act",
		name: "note",
		description: "Record an observation, optionally about a task.",
		inputSchema: obj({ taskId: str, text: str }, ["text"]),
	},
	{
		kind: "act",
		name: "sleep",
		description: "End the turn, leaving a wake hint (5 to 1440 minutes).",
		inputSchema: act({ wakeAfterMin: { type: "number" }, wakeOn: strs }, []),
	},
];

/** Network-level failure (daemon down or restarting), as opposed to a typed answer. */
export function isUnavailable(error: unknown): boolean {
	const data = (error as { data?: { code?: unknown } } | null)?.data;
	if (data && typeof data.code === "string") return false;
	const shape = (error as { shape?: { data?: { code?: unknown } } } | null)
		?.shape;
	return !(shape?.data && typeof shape.data.code === "string");
}

export interface RetryOptions {
	/** Give up after this long (design: 120 s). */
	budgetMs?: number;
	baseMs?: number;
	maxMs?: number;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

/**
 * Retry `fn` with backoff while the daemon is unreachable, up to the budget,
 * then resolve `{status: "unavailable"}` for the model. Typed errors (a
 * rejection, a precondition) are never retried. Retried act calls are safe:
 * the daemon keys them for idempotency.
 */
export async function withDaemonRetry<T>(
	fn: () => Promise<T>,
	o: RetryOptions = {},
): Promise<T | { status: "unavailable"; message: string }> {
	const budget = o.budgetMs ?? 120_000;
	const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
	const now = o.now ?? (() => Date.now());
	const started = now();
	let delay = o.baseMs ?? 1_000;
	for (;;) {
		try {
			return await fn();
		} catch (e) {
			if (!isUnavailable(e)) throw e;
			if (now() - started + delay > budget) {
				return {
					status: "unavailable",
					message: `the mfw daemon did not answer for ${Math.round(budget / 1000)}s: end your turn; you will be woken again`,
				};
			}
			await sleep(delay);
			delay = Math.min(delay * 2, o.maxMs ?? 15_000);
		}
	}
}

export interface BrainServerEnv {
	project: string;
	turnRunId: string;
	sessionId: string;
}

/** The brain's MCP server: its tools forwarded to `brain.*` on the daemon. */
export function buildBrainServer(
	client: MfwClient,
	env: BrainServerEnv,
	retry: RetryOptions = {},
): Server {
	const server = new Server(
		{ name: "mfw_brain", version: "0.1.0" },
		{ capabilities: { tools: {} } },
	);
	const byName = new Map(BRAIN_TOOLS.map((t) => [t.name, t]));
	server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: BRAIN_TOOLS.map(({ name, description, inputSchema }) => ({
			name,
			description,
			inputSchema,
		})) as unknown as { name: string }[],
	}));
	server.setRequestHandler(CallToolRequestSchema, async (req) => {
		const tool = byName.get(req.params.name);
		if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
		const args = (req.params.arguments ?? {}) as Record<string, unknown>;
		try {
			const result = await withDaemonRetry(
				() =>
					tool.kind === "read"
						? client.brain.read.query({
								project: env.project,
								tool: tool.name,
								args,
								turnRunId: env.turnRunId,
							})
						: client.brain.act.mutate({
								project: env.project,
								turnRunId: env.turnRunId,
								tool: tool.name,
								args,
							}),
				retry,
			);
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(result, null, 2) },
				],
			};
		} catch (e) {
			// A typed refusal is information for the model, not a transport failure.
			return {
				isError: true,
				content: [
					{
						type: "text" as const,
						text: e instanceof Error ? e.message : String(e),
					},
				],
			};
		}
	});
	return server;
}
