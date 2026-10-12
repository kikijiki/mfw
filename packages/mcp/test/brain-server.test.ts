import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	BRAIN_TOOLS,
	buildBrainServer,
	withDaemonRetry,
} from "../src/brain-server.ts";
import type { MfwClient } from "../src/client.ts";

const env = { project: "alpha", turnRunId: "R7", sessionId: "S1" };

function fakeClient(opts: { failures?: number; typed?: boolean } = {}) {
	const calls: { kind: string; input: unknown }[] = [];
	let failures = opts.failures ?? 0;
	const gate = async () => {
		if (failures > 0) {
			failures--;
			throw new TypeError("fetch failed");
		}
		if (opts.typed) {
			throw Object.assign(new Error("turn is not live"), {
				data: { code: "PRECONDITION_FAILED" },
			});
		}
	};
	const client = {
		brain: {
			read: {
				query: async (input: unknown) => {
					calls.push({ kind: "read", input });
					await gate();
					return { tasks: [] };
				},
			},
			act: {
				mutate: async (input: unknown) => {
					calls.push({ kind: "act", input });
					await gate();
					return { actionId: "A1", status: "proposed" };
				},
			},
		},
	} as unknown as MfwClient;
	return { client, calls };
}

async function connect(client: MfwClient) {
	const server = buildBrainServer(client, env, {
		sleep: async () => {},
	});
	const [a, b] = InMemoryTransport.createLinkedPair();
	await server.connect(b);
	const c = new Client({ name: "t", version: "1" });
	await c.connect(a);
	return c;
}

describe("mfw-mcp --brain", () => {
	test("exposes every read tool, set_plan, note and every act tool", async () => {
		const { client } = fakeClient();
		const c = await connect(client);
		const names = (await c.listTools()).tools.map((t) => t.name);
		for (const t of [
			"board",
			"task",
			"frontier",
			"runs",
			"run_report",
			"run_log",
			"diff",
			"capacity",
			"outcomes",
			"decisions",
			"set_plan",
			"note",
			"create_tasks",
			"update_task",
			"reparent",
			"split_task",
			"merge_tasks",
			"set_status",
			"answer_question",
			"spawn",
			"spawn_attempts",
			"select_winner",
			"request_review",
			"steer",
			"stop",
			"pause",
			"resume",
			"notify_human",
			"set_budget",
			"sleep",
		]) {
			expect(names).toContain(t);
		}
		expect(names).toHaveLength(BRAIN_TOOLS.length);
	});

	test("a read is a brain.read query and an act a brain.act mutation, both attributed to the turn", async () => {
		const { client, calls } = fakeClient();
		const c = await connect(client);
		await c.callTool({ name: "frontier", arguments: { limit: 5 } });
		await c.callTool({
			name: "spawn",
			arguments: { taskId: "MFW-1", role: "implement", rationale: "why" },
		});
		expect(calls[0]).toEqual({
			kind: "read",
			input: {
				project: "alpha",
				tool: "frontier",
				args: { limit: 5 },
				turnRunId: "R7",
			},
		});
		expect(calls[1]).toMatchObject({
			kind: "act",
			input: { project: "alpha", turnRunId: "R7", tool: "spawn" },
		});
	});

	test("a daemon that is briefly down is retried; the same call is sent again", async () => {
		const { client, calls } = fakeClient({ failures: 2 });
		const c = await connect(client);
		const r = await c.callTool({
			name: "note",
			arguments: { text: "hello" },
		});
		expect(calls.filter((x) => x.kind === "act")).toHaveLength(3);
		expect(JSON.stringify(r.content)).toContain("proposed");
	});

	test("a typed refusal is returned to the model, never retried", async () => {
		const { client, calls } = fakeClient({ typed: true });
		const c = await connect(client);
		const r = await c.callTool({ name: "note", arguments: { text: "x" } });
		expect(r.isError).toBe(true);
		expect(calls).toHaveLength(1);
	});
});

describe("withDaemonRetry", () => {
	test("gives up with `unavailable` once the 120 s budget is spent", async () => {
		let t = 0;
		let attempts = 0;
		const out = await withDaemonRetry(
			async () => {
				attempts++;
				throw new TypeError("fetch failed");
			},
			{
				budgetMs: 120_000,
				now: () => t,
				sleep: async (ms) => {
					t += ms;
				},
			},
		);
		expect(out).toMatchObject({ status: "unavailable" });
		expect(attempts).toBeGreaterThan(5);
		expect(t).toBeLessThanOrEqual(120_000);
	});
});
