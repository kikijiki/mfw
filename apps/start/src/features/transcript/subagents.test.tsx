import { describe, expect, test } from "bun:test";
import type { AgentEvent } from "@mfw/daemon/agents/events";
import type { FlowNode } from "@mfw/daemon/flow";
import { renderToStaticMarkup } from "react-dom/server";

// Vite provides BASE_URL (AppLink reads it); bun test does not.
process.env.BASE_URL ??= "/";

import { buildFlow, type FlowNodeIn, SUB_LINGER_MS } from "../flow/flowModel";
import { NodeRow, rowAccessibleName } from "../flow/NodeRow";
import { SubagentView } from "../inspector/SubagentInspector";
import { SubagentList } from "../inspector/story";
import { buildItems, TranscriptEntry } from "./entries";
import {
	ancestry,
	depthOf,
	subagentGroups,
	subagentSlice,
	visibleItems,
} from "./subagents";

/** U7-03: subagents in the transcript, the Flow tree, the inspector and the Story. */

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const MIN = 60_000;

let seq = 0;
function stream(...evs: Record<string, unknown>[]): AgentEvent[] {
	seq = 0;
	return evs.map(
		(e) =>
			({
				ts: new Date(T0 + seq * 1000).toISOString(),
				seq: seq++,
				...e,
			}) as AgentEvent,
	);
}
const call = (id: string, over: Record<string, unknown> = {}) => ({
	type: "tool_call",
	id,
	name: "Agent",
	input: { description: `do ${id}`, subagent_type: "Explore" },
	...over,
});
const inSub = (parent: string, e: Record<string, unknown>) => ({
	...e,
	parent: { toolUseId: parent },
});
const result = (id: string, over: Record<string, unknown> = {}) => ({
	type: "tool_result",
	id,
	ok: true,
	output: "done",
	...over,
});

/** A run: its own message, one finished subagent with a nested one, one running. */
const ENTRIES = stream(
	{ type: "message", role: "assistant", text: "starting" },
	call("outer"),
	inSub("outer", { type: "message", role: "user", text: "scan" }),
	inSub("outer", { type: "tool_call", id: "r1", name: "Read", input: {} }),
	inSub("outer", { type: "tool_result", id: "r1", ok: true, output: "A" }),
	inSub("outer", call("inner")),
	inSub("inner", { type: "tool_call", id: "g1", name: "Grep", input: {} }),
	inSub("inner", { type: "tool_result", id: "g1", ok: true, output: "B" }),
	inSub("outer", result("inner")),
	result("outer"),
	call("live"),
	inSub("live", { type: "tool_call", id: "b1", name: "Bash", input: {} }),
	{ type: "message", role: "assistant", text: "back at the run" },
);

describe("subagents in the transcript", () => {
	test("buildItems tags a subagent's entries with its parent; the run's own stay bare", () => {
		const items = buildItems(ENTRIES);
		const parents = items.map((i) => [
			i.kind === "tool" ? i.id : i.kind,
			i.parent,
		]);
		expect(parents).toEqual([
			["message", undefined],
			["outer", undefined],
			["message", "outer"],
			["r1", "outer"],
			["inner", "outer"],
			["g1", "inner"],
			["live", undefined],
			["b1", "live"],
			["message", undefined],
		]);
		// The result folded into its call does not move the call.
		expect(items.find((i) => i.kind === "tool" && i.id === "r1")?.parent).toBe(
			"outer",
		);
	});

	test("groups count entries and tools, know their parent and whether they finished", () => {
		const groups = subagentGroups(buildItems(ENTRIES));
		expect(
			[...groups.values()].map((g) => [
				g.key,
				g.parentKey,
				g.entries,
				g.tools,
				g.finished,
				g.agentType,
				g.description,
			]),
		).toEqual([
			["outer", null, 3, 2, true, "Explore", "do outer"],
			["inner", "outer", 1, 1, true, "Explore", "do inner"],
			["live", null, 1, 1, false, "Explore", "do live"],
		]);
	});

	test("depth follows the chain of subagents", () => {
		const items = buildItems(ENTRIES);
		const groups = subagentGroups(items);
		const depth = (id: string) =>
			depthOf(
				items.find((i) => i.kind === "tool" && i.id === id) as never,
				groups,
			);
		expect(depth("outer")).toBe(0);
		expect(depth("r1")).toBe(1);
		expect(depth("inner")).toBe(1);
		expect(depth("g1")).toBe(2);
		expect(ancestry("inner", groups)).toEqual(["inner", "outer"]);
	});

	test("a finished subagent collapses to its call; a running one stays open; a toggle flips either", () => {
		const items = buildItems(ENTRIES);
		const groups = subagentGroups(items);
		const ids = (list: ReturnType<typeof visibleItems>) =>
			list.map((i) => (i.kind === "tool" ? i.id : i.kind));
		expect(ids(visibleItems(items, new Set(), groups))).toEqual([
			"message",
			"outer",
			"live",
			"b1",
			"message",
		]);
		// Open the finished one: its entries and the nested call show, the nested one stays shut.
		expect(ids(visibleItems(items, new Set(["outer"]), groups))).toEqual([
			"message",
			"outer",
			"message",
			"r1",
			"inner",
			"live",
			"b1",
			"message",
		]);
		expect(
			ids(visibleItems(items, new Set(["outer", "inner"]), groups)),
		).toContain("g1");
		// Collapse the running one.
		expect(ids(visibleItems(items, new Set(["live"]), groups))).not.toContain(
			"b1",
		);
	});

	test("the slice of one subagent: its call, result, entries and the subagents it started", () => {
		const inner = subagentSlice(ENTRIES, "inner");
		expect(inner.map((e) => e.type)).toEqual([
			"tool_call",
			"tool_call",
			"tool_result",
			"tool_result",
		]);
		const outer = subagentSlice(ENTRIES, "outer");
		// outer's call, its prompt, r1 and its result, inner's call, g1 and its
		// result, inner's result, outer's result.
		expect(outer.length).toBe(9);
		expect(outer.some((e) => e.type === "message" && !e.parent)).toBeFalse();
		const live = subagentSlice(ENTRIES, "live");
		expect(live.map((e) => e.seq)).toEqual([10, 11]);
	});

	test("a nested entry renders indented under its call, with the chip on the call", () => {
		const items = buildItems(ENTRIES);
		const groups = subagentGroups(items);
		const outerCall = items.find(
			(i) => i.kind === "tool" && i.id === "outer",
		) as never;
		const html = renderToStaticMarkup(
			<TranscriptEntry
				item={outerCall}
				expanded={false}
				onToggle={() => {}}
				subagent={{
					entries: groups.get("outer")?.entries ?? 0,
					tools: groups.get("outer")?.tools ?? 0,
					finished: true,
					open: false,
					onToggle: () => {},
				}}
			/>,
		);
		expect(html).toContain("data-subagent-toggle");
		expect(html).toContain("3 entries");
		expect(html).toContain("2 tools");
		expect(html).toContain('aria-expanded="false"');

		const child = items.find(
			(i) => i.kind === "tool" && i.id === "r1",
		) as never;
		const nested = renderToStaticMarkup(
			<TranscriptEntry
				item={child}
				depth={1}
				expanded={false}
				onToggle={() => {}}
			/>,
		);
		expect(nested).toContain('data-depth="1"');
		expect(nested).toContain('data-subagent="outer"');
		expect(nested).toContain("margin-left:16px");
		// The run's own entries carry none of it.
		const own = renderToStaticMarkup(
			<TranscriptEntry
				item={items[0] as never}
				expanded={false}
				onToggle={() => {}}
			/>,
		);
		expect(own).not.toContain("data-depth");
		expect(own).not.toContain("data-subagent");
	});
});

describe("subagent inspector", () => {
	const info = {
		runId: "R1",
		agentType: "Explore",
		description: "do inner",
		status: "ok" as const,
		startedAt: new Date(T0),
		endedAt: new Date(T0 + 2 * MIN),
		tools: { Grep: 1 },
		parentRef: "sub:R1/outer",
	};

	test("shows the header and only the subagent's slice, the prompt expanded", () => {
		const html = renderToStaticMarkup(
			<SubagentView
				project="demo"
				info={info}
				entries={ENTRIES}
				now={T0 + 5 * MIN}
				toolUseId="inner"
			/>,
		);
		expect(html).toContain("data-subagent-inspector");
		expect(html).toContain("do inner");
		expect(html).toContain("done");
		expect(html).toContain("1 tool call");
		// parent breadcrumb is a link to the outer subagent
		expect(html).toContain("subagent");
		expect(html).toContain("/p/demo/n/sub:R1%2Fouter");
		// its own entries are there, the run's and the other subagents' are not
		expect(html).toContain("Grep");
		expect(html).not.toContain("starting");
		expect(html).not.toContain("back at the run");
		expect(html).not.toContain("Bash");
		// the call is open: its input (the prompt) shows
		expect(html).toContain("subagent_type");
	});

	test("an empty slice says so", () => {
		const html = renderToStaticMarkup(
			<SubagentView
				project="demo"
				info={info}
				entries={[]}
				now={T0}
				toolUseId="ghost"
			/>,
		);
		expect(html).toContain("No entries yet");
	});
});

function sub(
	runId: string,
	id: string,
	parent: string,
	over: Partial<NonNullable<FlowNode["sub"]>> = {},
): FlowNodeIn {
	return {
		ref: `sub:${runId}/${id}`,
		parent,
		kind: "sub",
		title: `do ${id}`,
		needsMe: null,
		lastAt: new Date(T0),
		sub: {
			runId,
			toolUseId: id,
			agentType: "Explore",
			description: `do ${id}`,
			status: "ok",
			startedAt: new Date(T0 - 10 * MIN),
			endedAt: new Date(T0 - 9 * MIN),
			tools: { Read: 2 },
			entryFromSeq: 1,
			entryToSeq: 5,
			...over,
		},
	} as FlowNodeIn;
}

function runNode(id: string): FlowNodeIn {
	return {
		ref: `run:${id}`,
		parent: null,
		kind: "run",
		title: id,
		needsMe: null,
		lastAt: new Date(T0),
		run: {
			role: "worker",
			relation: "fresh",
			state: "completed",
			activity: null,
			harness: "claude-cli",
			model: "claude-opus-4-5",
			effort: null,
			host: null,
			label: id,
			startedAt: new Date(T0 - 20 * MIN),
			finishedAt: new Date(T0 - 5 * MIN),
			costUsd: null,
			liveCostUsd: null,
		},
	} as FlowNodeIn;
}

describe("subagents in the Flow tree", () => {
	test("a run with finished subagents is collapsed with a fork count; a running one opens it", () => {
		const done = [
			runNode("r"),
			sub("r", "a", "run:r"),
			sub("r", "b", "run:r"),
			sub("r", "c", "sub:r/a"),
		];
		const view = buildFlow(done, { now: T0 });
		expect(view.rows.map((r) => r.key)).toEqual(["run:r"]);
		expect(view.rows[0]?.subs).toEqual({ count: 3, running: 0 });
		expect(view.rows[0]?.expandable).toBe(true);
		expect(view.rows[0]?.expanded).toBe(false);

		const live = [
			runNode("r"),
			sub("r", "a", "run:r"),
			sub("r", "b", "run:r", { status: "running", endedAt: null }),
		];
		const open = buildFlow(live, { now: T0 });
		expect(open.rows.map((r) => r.key)).toEqual([
			"run:r",
			"sub:r/a",
			"sub:r/b",
		]);
		expect(open.rows[0]?.expanded).toBe(true);
		expect(open.rows[0]?.subs).toEqual({ count: 2, running: 1 });
		expect(open.rows[2]?.depth).toBe(1);
	});

	test("a subagent that just ended keeps the run open for 30 s, then collapses", () => {
		const nodes = [
			runNode("r"),
			sub("r", "a", "run:r", { endedAt: new Date(T0 - 5_000) }),
		];
		expect(buildFlow(nodes, { now: T0 }).rows).toHaveLength(2);
		const later = buildFlow(nodes, { now: T0 - 5_000 + SUB_LINGER_MS + 1 });
		expect(later.rows.map((r) => r.key)).toEqual(["run:r"]);
	});

	test("subagents are not runs: the chain summary and the live filter ignore them", () => {
		const nodes = [
			runNode("r"),
			sub("r", "a", "run:r", { status: "running", endedAt: null }),
		];
		const view = buildFlow(nodes, { now: T0, overrides: { "run:r": false } });
		expect(view.rows[0]?.chain).toBeUndefined();
		const live = buildFlow(nodes, { now: T0, filter: { live: true } });
		expect(live.rows.map((r) => r.key)).toEqual([]);
	});

	test("the row renders its kind, type, tools and a name a screen reader can use", () => {
		const nodes = [
			runNode("r"),
			sub("r", "a", "run:r", { status: "running", endedAt: null }),
		];
		const view = buildFlow(nodes, { now: T0 });
		const subRow = view.rows[1];
		if (!subRow) throw new Error("no sub row");
		const html = renderToStaticMarkup(
			<NodeRow row={subRow} now={T0} mode="list" />,
		);
		expect(html).toContain('data-glyph="fork"');
		expect(html).toContain("Explore");
		expect(html).toContain("do a");
		expect(html).toContain("2 tools");
		expect(html).toContain("running");
		expect(rowAccessibleName(subRow, T0)).toBe(
			"do a, subagent Explore, running for 10 minutes",
		);
		// the closed run row carries the chip
		const closed = buildFlow(
			[runNode("r"), sub("r", "a", "run:r"), sub("r", "b", "run:r")],
			{ now: T0 },
		);
		const runRow = closed.rows[0];
		if (!runRow) throw new Error("no run row");
		const runHtml = renderToStaticMarkup(
			<NodeRow row={runRow} now={T0} mode="list" />,
		);
		expect(runHtml).toMatch(/data-glyph="fork"[\s\S]*?\+2/);
	});
});

describe("subagents in the Story", () => {
	const subs = [
		{
			ref: "sub:r/a",
			parentRef: null,
			agentType: "Explore",
			description: "scan",
			status: "ok" as const,
			startedAt: new Date(T0),
			endedAt: new Date(T0 + MIN),
			toolCalls: 3,
		},
		{
			ref: "sub:r/b",
			parentRef: "sub:r/a",
			agentType: "Plan",
			description: "nested",
			status: "running" as const,
			startedAt: new Date(T0),
			endedAt: null,
			toolCalls: 0,
		},
	];

	test("collapsed fork count when none is running, each linking to its inspector when open", () => {
		const shut = renderToStaticMarkup(
			<SubagentList project="demo" subagents={[subs[0] as (typeof subs)[0]]} />,
		);
		expect(shut).toContain('data-glyph="fork"');
		expect(shut).toContain("+1");
		expect(shut).not.toContain("scan");

		const open = renderToStaticMarkup(
			<SubagentList project="demo" subagents={subs} />,
		);
		// one is running: open by default
		expect(open).toContain("1 running");
		expect(open).toContain("scan");
		expect(open).toContain("nested");
		expect(open).toContain("3 tools");
		expect(open).toContain("/p/demo/n/sub:r%2Fa");
	});
});
