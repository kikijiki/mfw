import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildItems, isFailure, itemText } from "./entries";

/**
 * Run-log regressions: the Claude CLI (`stream-json`) emits a thinking block
 * per turn with an empty `thinking` string, which must not render; and every
 * item's `ts` must be displayed.
 */

const ev = (over: Record<string, unknown>) => ({
	seq: 1,
	ts: "2026-08-14T20:33:30.039Z",
	...over,
});

describe("the run log", () => {
	test("an empty thinking block is not an entry", () => {
		const items = buildItems([
			ev({ seq: 1, type: "thinking", text: "" }),
			ev({ seq: 2, type: "thinking", text: "   " }),
			ev({ seq: 3, type: "message", role: "assistant", text: "hello" }),
			// biome-ignore lint/suspicious/noExplicitAny: the fixture is deliberately loose
		] as any);

		expect(items.map((i) => i.kind)).toEqual(["message"]);
	});

	test("a thinking block WITH text is kept", () => {
		const items = buildItems([
			ev({ seq: 1, type: "thinking", text: "weighing two options" }),
			// biome-ignore lint/suspicious/noExplicitAny: the fixture is deliberately loose
		] as any);

		expect(items).toHaveLength(1);
		expect(items[0]?.kind).toBe("thinking");
	});

	test("every entry carries the timestamp the row needs", () => {
		const items = buildItems([
			ev({ seq: 1, type: "message", role: "assistant", text: "hello" }),
			// biome-ignore lint/suspicious/noExplicitAny: the fixture is deliberately loose
		] as any);

		expect(items[0]?.ts).toBe("2026-08-14T20:33:30.039Z");
	});

	test("the entry renders that timestamp", () => {
		const src = readFileSync(join(import.meta.dir, "entries.tsx"), "utf8");
		expect(src).toContain("<time");
		expect(src).toContain("dateTime={item.ts}");
		expect(src).toContain("{clock(item.ts)}");
	});

	test("rich events remain visible and searchable", () => {
		const items = buildItems([
			ev({
				seq: 1,
				type: "session",
				provider: "codex-cli",
				sessionId: "thread-1",
				turnId: "turn-1",
				status: "active",
				ordinal: 1,
			}),
			ev({
				seq: 2,
				type: "plan",
				explanation: "ship it",
				steps: [{ step: "write tests", status: "in_progress" }],
			}),
			ev({ seq: 3, type: "diff", turnId: "turn-1", diff: "+tested" }),
			ev({
				seq: 4,
				type: "file_change",
				id: "fc-1",
				phase: "completed",
				changes: [{ path: "src/a.ts", kind: "update", diff: "+export" }],
			}),
			ev({
				seq: 5,
				type: "mcp_activity",
				id: "mcp-1",
				server: "github",
				tool: "search",
				phase: "completed",
				output: { hits: 2 },
				ok: true,
			}),
			ev({
				seq: 6,
				type: "approval",
				requestId: "req-1",
				kind: "command",
				status: "pending",
				summary: "run tests",
			}),
			ev({
				seq: 7,
				type: "notice",
				category: "model_reroute",
				message: "using fallback",
			}),
			// biome-ignore lint/suspicious/noExplicitAny: the fixture is deliberately loose
		] as any);

		expect(items.map((item) => item.kind)).toEqual([
			"plan",
			"diff",
			"file_change",
			"mcp_activity",
			"approval",
			"notice",
		]);
		expect(items.map(itemText).join(" ")).toContain("write tests");
		expect(items.map(itemText).join(" ")).toContain("src/a.ts");
		expect(items.map(itemText).join(" ")).toContain("using fallback");
	});

	test("tool progress is attached to its matching tool", () => {
		const items = buildItems([
			ev({
				seq: 1,
				type: "tool_call",
				id: "cmd-1",
				name: "bash",
				input: { command: "bun test" },
			}),
			ev({ seq: 2, type: "tool_progress", id: "cmd-1", output: "one\n" }),
			ev({ seq: 3, type: "tool_progress", id: "cmd-1", output: "two\n" }),
			ev({
				seq: 4,
				type: "tool_result",
				id: "cmd-1",
				ok: true,
				output: "done",
			}),
			// biome-ignore lint/suspicious/noExplicitAny: the fixture is deliberately loose
		] as any);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			kind: "tool",
			progress: "one\ntwo\n",
			result: { ok: true, output: "done" },
		});
	});

	test("progressive rich events evolve in place without changing their deep-link sequence", () => {
		const items = buildItems([
			ev({
				seq: 10,
				type: "session",
				provider: "codex-cli",
				sessionId: "thread-1",
				status: "started",
				ordinal: 1,
			}),
			ev({
				seq: 11,
				type: "session",
				provider: "codex-cli",
				sessionId: "thread-1",
				turnId: "turn-1",
				status: "active",
				ordinal: 1,
			}),
			ev({
				seq: 12,
				type: "plan",
				steps: [{ step: "inspect", status: "in_progress" }],
			}),
			ev({
				seq: 13,
				type: "plan",
				explanation: "inspection finished",
				steps: [{ step: "inspect", status: "completed" }],
			}),
			ev({ seq: 14, type: "diff", turnId: "turn-1", diff: "+first" }),
			ev({ seq: 15, type: "diff", turnId: "turn-1", diff: "+final" }),
			ev({
				seq: 16,
				type: "session",
				provider: "codex-cli",
				sessionId: "thread-1",
				turnId: "turn-1",
				status: "completed",
				ordinal: 1,
			}),
			// biome-ignore lint/suspicious/noExplicitAny: the fixture is deliberately loose
		] as any);

		expect(items.map((item) => item.kind)).toEqual(["plan", "diff"]);
		expect(items.map((item) => item.seq)).toEqual([12, 14]);
		expect(items[0]).toMatchObject({
			kind: "plan",
			seqs: [12, 13],
			latestSeq: 13,
			explanation: "inspection finished",
			steps: [{ step: "inspect", status: "completed" }],
		});
		expect(items[1]).toMatchObject({
			kind: "diff",
			seqs: [14, 15],
			latestSeq: 15,
			diff: "+final",
		});
		expect(items.map(itemText).join(" ")).not.toContain("+first");
	});

	test("plans remain separate across turns", () => {
		const items = buildItems([
			ev({
				seq: 1,
				type: "session",
				provider: "codex-cli",
				sessionId: "thread-1",
				turnId: "turn-1",
				status: "active",
				ordinal: 1,
			}),
			ev({
				seq: 2,
				type: "plan",
				steps: [{ step: "first turn", status: "completed" }],
			}),
			ev({
				seq: 3,
				type: "session",
				provider: "codex-cli",
				sessionId: "thread-1",
				turnId: "turn-2",
				status: "active",
				ordinal: 2,
			}),
			ev({
				seq: 4,
				type: "plan",
				steps: [{ step: "second turn", status: "pending" }],
			}),
			// biome-ignore lint/suspicious/noExplicitAny: the fixture is deliberately loose
		] as any);

		expect(items.filter((item) => item.kind === "plan")).toHaveLength(2);
		expect(items.map(itemText).join(" ")).toContain("first turn");
		expect(items.map(itemText).join(" ")).toContain("second turn");
	});

	test("file, MCP, and approval lifecycles fold by correlation id", () => {
		const items = buildItems([
			ev({
				seq: 1,
				type: "file_change",
				id: "file-1",
				phase: "started",
				changes: [{ path: "src/a.ts", kind: "update", diff: "+draft" }],
			}),
			ev({
				seq: 2,
				type: "file_change",
				id: "file-1",
				phase: "completed",
				status: "applied",
				changes: [{ path: "src/a.ts", kind: "update", diff: "+final" }],
			}),
			ev({
				seq: 3,
				type: "mcp_activity",
				id: "mcp-1",
				server: "github",
				tool: "search",
				phase: "started",
				input: { query: "needle" },
			}),
			ev({
				seq: 4,
				type: "mcp_activity",
				id: "mcp-1",
				tool: "search",
				phase: "completed",
				output: { hits: 2 },
				ok: true,
			}),
			ev({
				seq: 5,
				type: "approval",
				requestId: "approval-1",
				kind: "command",
				status: "pending",
				summary: "run tests",
				details: { command: "bun test" },
			}),
			ev({
				seq: 6,
				type: "approval",
				requestId: "approval-1",
				kind: "command",
				status: "accepted",
				summary: "Approval resolved",
			}),
			// biome-ignore lint/suspicious/noExplicitAny: the fixture is deliberately loose
		] as any);

		expect(items.map((item) => item.kind)).toEqual([
			"file_change",
			"mcp_activity",
			"approval",
		]);
		expect(items[0]).toMatchObject({
			seq: 1,
			latestSeq: 2,
			phase: "completed",
			status: "applied",
		});
		expect(items[1]).toMatchObject({
			seq: 3,
			latestSeq: 4,
			phase: "completed",
			server: "github",
			input: { query: "needle" },
			output: { hits: 2 },
		});
		expect(items[2]).toMatchObject({
			seq: 5,
			latestSeq: 6,
			status: "accepted",
			summary: "run tests",
			details: { command: "bun test" },
		});
		expect(items.map(itemText).join(" ")).toContain("approval-1");
	});

	test("rich failures remain part of error navigation", () => {
		const items = buildItems([
			ev({
				seq: 1,
				type: "file_change",
				id: "file-failed",
				phase: "completed",
				status: "failed",
				changes: [],
			}),
			ev({
				seq: 2,
				type: "mcp_activity",
				id: "mcp-failed",
				tool: "lookup",
				phase: "completed",
				ok: false,
			}),
			// biome-ignore lint/suspicious/noExplicitAny: the fixture is deliberately loose
		] as any);

		expect(items.filter(isFailure)).toHaveLength(2);
	});

	test("rich activity suppresses a duplicate generic tool row in either order", () => {
		const items = buildItems([
			ev({ type: "tool_call", seq: 1, id: "file-1", name: "edit", input: {} }),
			ev({
				type: "file_change",
				seq: 2,
				id: "file-1",
				phase: "completed",
				changes: [{ path: "a.ts", kind: "update" }],
			}),
			ev({
				type: "mcp_activity",
				seq: 3,
				id: "mcp-1",
				tool: "search",
				phase: "started",
			}),
			ev({ type: "tool_call", seq: 4, id: "mcp-1", name: "mcp", input: {} }),
			ev({ type: "tool_call", seq: 5, id: "bash-1", name: "bash", input: {} }),
			// biome-ignore lint/suspicious/noExplicitAny: the fixture is deliberately loose
		] as any);

		expect(items.map((item) => item.kind)).toEqual([
			"file_change",
			"mcp_activity",
			"tool",
		]);
		expect(items.at(-1)).toMatchObject({ kind: "tool", id: "bash-1" });
	});

	test("quota telemetry is quiet and repeated updates fold into one current state", () => {
		const allowed = buildItems([
			ev({
				seq: 1,
				type: "rate_limit",
				status: "allowed",
				limited: false,
				utilization: 0.42,
				resetsAt: null,
			}),
			// biome-ignore lint/suspicious/noExplicitAny: the fixture is deliberately loose
		] as any);
		expect(allowed).toHaveLength(1);
		expect(itemText(allowed[0] as never)).toContain(
			"quota update allowed 42% used",
		);
		expect(itemText(allowed[0] as never)).not.toContain("rate limited");

		const items = buildItems([
			ev({
				seq: 1,
				type: "rate_limit",
				status: "allowed",
				limited: false,
				utilization: 0.42,
				resetsAt: null,
			}),
			ev({
				seq: 2,
				type: "rate_limit",
				status: "exhausted",
				limited: true,
				resetsAt: 1_800_000_000,
			}),
			// biome-ignore lint/suspicious/noExplicitAny: the fixture is deliberately loose
		] as any);

		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			kind: "rate_limit",
			limited: true,
			latestSeq: 2,
		});
	});
});
