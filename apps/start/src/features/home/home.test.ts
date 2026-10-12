import { describe, expect, test } from "bun:test";
import type { AppRouter } from "@mfw/api";
import type { FlowNode } from "@mfw/daemon/flow";
import type { InboxItem } from "@mfw/daemon/inbox";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import { FlowLens } from "../flow/FlowPage";
import { HomePage } from "./HomePage";
import { liveProjects, liveRows } from "./live";
import { inlineKind, NeedsQueue, queueOrder } from "./NeedsQueue";
import { answersInPlace, needTarget, nextNeedTarget } from "./needs";
import {
	ActivityHistogram,
	barHeights,
	bucketLink,
	markCaughtUp,
	splitDigests,
} from "./SinceYouLeft";

const item = (over: Partial<InboxItem> & { id: string }): InboxItem => ({
	project: "mfw",
	kind: "needs_answer",
	ref: `run:${over.id}`,
	severity: "attention",
	title: `Item ${over.id}`,
	detail: "",
	ts: 1000,
	...over,
});

const activeRun = (over: Record<string, unknown> = {}) => ({
	project: "mfw",
	runId: "R1",
	kind: "task",
	state: "running",
	label: "MFW-41",
	model: "claude-sonnet",
	providerId: null,
	route: null,
	reasoningEffort: null,
	taskId: "MFW-41",
	taskTitle: "Parse config v2",
	attempt: 1,
	activity: "working",
	activityDetail: null,
	scopeSample: null,
	capabilities: {
		verified: true,
		steer: true,
		interrupt: true,
		approvals: true,
	},
	steerable: true,
	startedAt: 1,
	...over,
});

/** A task and a live run as `flow.live` returns them. */
const flowTask = (id: string, title: string): FlowNode => ({
	ref: `task:${id}`,
	parent: null,
	kind: "task" as const,
	title,
	status: { value: "in_progress", role: "in_progress" },
	rollup: { total: 1, done: 0, live: 1, needsMe: 0, costUsdToday: 0 },
	needsMe: null,
	lastAt: new Date(),
});
// Aligned to the minute so two renders print the same "5h".
const FIVE_HOURS_AGO = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 3_600_000;
const flowRun = (
	id: string,
	parent: string,
	startedOffset = 0,
	activity = "working",
): FlowNode => ({
	ref: `run:${id}`,
	parent,
	kind: "run" as const,
	title: `${id} label`,
	needsMe: activity === "needs_answer" ? ("question" as const) : null,
	lastAt: new Date(),
	run: {
		role: "worker",
		relation: "fresh",
		state: "running",
		activity,
		harness: "claude-cli",
		model: "claude-sonnet-4-5",
		effort: null,
		host: null,
		label: `${id} label`,
		startedAt: new Date(FIVE_HOURS_AGO + startedOffset),
		finishedAt: null,
		costUsd: null,
		liveCostUsd: null,
	},
});

interface Seed {
	inbox?: InboxItem[];
	runs?: ReturnType<typeof activeRun>[];
	/** `flow.live` per project, as the daemon returns it. */
	flowLive?: Record<string, unknown[]>;
	questions?: unknown[];
	sessions?: unknown[];
}

function renderWith(seed: Seed, build: () => ReactElement): string {
	const queryClient = new QueryClient();
	const client = createTRPCClient<AppRouter>({ links: [] });
	const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
	const inbox = seed.inbox ?? [];
	queryClient.setQueryData(trpc.inbox.list.queryKey(), {
		items: inbox,
		counts: {
			total: inbox.length,
			critical: inbox.filter((i) => i.severity === "critical").length,
			attention: inbox.filter((i) => i.severity === "attention").length,
		},
	} as never);
	queryClient.setQueryData(
		trpc.runs.active.queryKey(),
		(seed.runs ?? []) as never,
	);
	for (const [project, nodes] of Object.entries(seed.flowLive ?? {})) {
		queryClient.setQueryData(trpc.flow.live.queryKey({ project }), {
			nodes,
			seq: 1,
		} as never);
	}
	queryClient.setQueryData(
		trpc.clarify.open.queryKey(),
		(seed.questions ?? []) as never,
	);
	queryClient.setQueryData(
		trpc.sessions.open.queryKey(),
		(seed.sessions ?? []) as never,
	);
	return renderToStaticMarkup(
		createElement(
			ToastProvider,
			null,
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(TRPCProvider, {
					trpcClient: client,
					queryClient,
					// biome-ignore lint/correctness/noChildrenProp: createElement(TRPCProvider, props) needs children inside props to typecheck
					children: build(),
				}),
			),
		),
	);
}

describe("needs rules", () => {
	test("questions are answered in place; nothing else is", () => {
		expect(answersInPlace("needs_answer")).toBe(true);
		expect(answersInPlace("clarify")).toBe(true);
		expect(answersInPlace("approval_pending")).toBe(false);
		expect(answersInPlace("review")).toBe(false);
	});

	test("a review opens the task inspector's Changes tab, not a page", () => {
		const to = needTarget(item({ id: "r", kind: "review", taskId: "MFW-9" }));
		expect(to).toBe("/p/mfw/board?node=task:MFW-9&tab=changes");
	});

	test("the brain's items open the brain inspector, or the task they block", () => {
		expect(needTarget(item({ id: "s", kind: "brain_stuck" }))).toBe(
			"/p/mfw/flow?node=brain",
		);
		expect(needTarget(item({ id: "n", kind: "brain_notice" }))).toBe(
			"/p/mfw/flow?node=brain",
		);
		expect(
			needTarget(item({ id: "n", kind: "brain_notice", taskId: "MFW-3" })),
		).toBe("/p/mfw/tasks/MFW-3");
	});

	test("n lands on the oldest item", () => {
		const items = [
			item({ id: "a", kind: "stalled", runId: "RA", ts: 500 }),
			item({ id: "b", kind: "stalled", runId: "RB", ts: 100 }),
		];
		expect(nextNeedTarget(items)).toBe("/p/mfw/runs/RB");
	});

	test("the queue works the most severe first, then the oldest", () => {
		const ordered = queueOrder([
			item({ id: "info", severity: "info", ts: 1 }),
			item({ id: "new-attn", severity: "attention", ts: 9 }),
			item({ id: "old-attn", severity: "attention", ts: 2 }),
			item({ id: "crit", severity: "critical", ts: 5 }),
		]);
		expect(ordered.map((i) => i.id)).toEqual([
			"crit",
			"old-attn",
			"new-attn",
			"info",
		]);
	});

	test("each kind has an inline control or is opened", () => {
		expect(inlineKind("needs_answer")).toBe("answer");
		expect(inlineKind("approval_pending")).toBe("run");
		expect(inlineKind("stalled")).toBe("run");
		expect(inlineKind("merge_parked")).toBe("merge");
		expect(inlineKind("review")).toBe("review");
		expect(inlineKind("followups")).toBe("open");
	});
});

describe("NeedsQueue", () => {
	const question = {
		project: "mfw",
		runId: "R1",
		kind: "task",
		taskId: "MFW-41",
		openCount: 1,
		createdAt: new Date(1000),
		items: [{ index: 0, question: "Reject or migrate v1 keys?", answer: null }],
	};

	test("a question is answerable inline with the answer box", () => {
		const html = renderWith(
			{
				inbox: [item({ id: "q", runId: "R1", taskId: "MFW-41" })],
				questions: [question],
			},
			() =>
				createElement(NeedsQueue, {
					items: [item({ id: "q", runId: "R1", taskId: "MFW-41" })],
					runs: [],
				}),
		);
		expect(html).toContain("Reject or migrate v1 keys?");
		expect(html).toContain("Answer and resume");
	});

	test("an approval is approvable inline through the run's console", () => {
		const approval = item({
			id: "a",
			kind: "approval_pending",
			runId: "R1",
			taskId: "MFW-41",
		});
		const html = renderWith({ inbox: [approval], runs: [activeRun()] }, () =>
			createElement(NeedsQueue, {
				items: [approval],
				runs: [activeRun()] as never,
			}),
		);
		expect(html).toContain("Review approval");
		// Collapsed: no transcript stream is open until it is asked for.
		expect(html).not.toContain("Open transcript");
	});

	test("a parked merge offers retry, send to ready and abandon", () => {
		const parked = item({
			id: "m",
			kind: "merge_parked",
			severity: "critical",
			mergeJobId: 7,
			taskId: "MFW-9",
		});
		const html = renderWith({ inbox: [parked] }, () =>
			createElement(NeedsQueue, { items: [parked], runs: [] }),
		);
		expect(html).toContain("Retry");
		expect(html).toContain("Send to ready");
		expect(html).toContain("Abandon");
	});

	test("a review item links to the Changes tab", () => {
		const review = item({ id: "r", kind: "review", taskId: "MFW-9" });
		const html = renderWith({ inbox: [review] }, () =>
			createElement(NeedsQueue, { items: [review], runs: [] }),
		);
		expect(html).toContain("Open changes");
		expect(html).toContain("tab=changes");
	});

	test("an empty queue says nothing needs you", () => {
		const html = renderWith({}, () =>
			createElement(NeedsQueue, { items: [], runs: [] }),
		);
		expect(html).toContain("Nothing needs you.");
	});
});

describe("HomePage", () => {
	const session = {
		project: "mfw",
		id: "01S",
		source: "merge_parked",
		sourceKey: "job:7",
		taskId: null,
		runId: null,
		mergeJobId: 7,
		title: "Merge of MFW-9 parked after 3 attempts",
		context: "## What failed",
		createdAt: new Date("2026-10-01T00:00:00Z"),
		openedRunId: null,
		openedAt: null,
		resolvedAt: null,
		resolution: null,
		resolutionReason: null,
	};

	test("the needs count is the inbox.list length, and the three sections show", () => {
		const inbox = [
			item({ id: "1", kind: "review", taskId: "MFW-1" }),
			item({ id: "2", kind: "review", taskId: "MFW-2" }),
			item({ id: "3", kind: "followups", severity: "info" }),
		];
		const html = renderWith({ inbox, runs: [activeRun()] }, () =>
			createElement(HomePage),
		);
		expect(html).toContain("3 need you");
		expect(html).toContain('aria-label="Needs you"');
		expect(html).toContain('aria-label="Live"');
		expect(html).toContain('aria-label="Since you left"');
		expect(html.match(/data-need="/g)?.length).toBe(3);
	});

	test("escalations are listed so they can be started and resolved", () => {
		const html = renderWith({ sessions: [session] }, () =>
			createElement(HomePage),
		);
		expect(html).toContain("Escalations");
		expect(html).toContain("Start session");
		expect(html).toContain("Merge of MFW-9 parked after 3 attempts");
		// Not "nothing needs you" while an escalation waits.
		expect(html).not.toContain("Nothing needs you.");
	});

	test("live runs are grouped project, then task, as the Flow rows", () => {
		const html = renderWith(
			{
				runs: [
					activeRun(),
					activeRun({ runId: "R2", attempt: 2, startedAt: 2 }),
					activeRun({
						project: "jev",
						runId: "R3",
						taskId: "JEV-12",
						taskTitle: "Overlay fps",
					}),
				],
				flowLive: {
					mfw: [
						flowTask("MFW-41", "Parse config v2"),
						flowRun("R1", "task:MFW-41"),
						flowRun("R2", "task:MFW-41"),
					],
					jev: [
						flowTask("JEV-12", "Overlay fps"),
						flowRun("R3", "task:JEV-12"),
					],
				},
			},
			() => createElement(HomePage),
		);
		expect(html).toContain("Parse config v2");
		expect(html).toContain("Overlay fps");
		// One task row for two attempts, with both runs under it.
		expect(html.match(/data-key="task:MFW-41"/g)?.length).toBe(1);
		expect(html).toContain('data-key="run:R1"');
		expect(html).toContain('data-key="run:R2"');
		expect(html).toContain('data-live-project="mfw"');
		expect(html).toContain('data-live-project="jev"');
		// Rows link into that project's Flow with the node selected.
		expect(html).toContain('href="/p/mfw/flow?node=run:R2"');
		expect(html).toContain('href="/p/jev/flow?node=task:JEV-12"');
	});
});

describe("live section rows", () => {
	test("projects with live work, by name, with their counts", () => {
		expect(
			liveProjects([
				{ project: "mfw" },
				{ project: "jev" },
				{ project: "mfw" },
			]),
		).toEqual([
			{ project: "jev", runCount: 1 },
			{ project: "mfw", runCount: 2 },
		]);
		expect(liveProjects(undefined)).toEqual([]);
	});

	test("rows are the live subset flattened: task, then its runs oldest first", () => {
		const rows = liveRows([
			flowTask("T-2", "Two"),
			flowRun("b", "task:T-2", 20),
			flowRun("a", "task:T-2", 10),
			flowTask("T-1", "One"),
			flowRun("c", "task:T-1", 5),
		]);
		expect(rows.map((r) => r.key)).toEqual([
			"task:T-2",
			"run:a",
			"run:b",
			"task:T-1",
			"run:c",
		]);
		expect(rows.map((r) => r.depth)).toEqual([0, 1, 1, 0, 1]);
	});

	test("a run reads the same on Home as in the project's Flow rows", () => {
		const nodes = [
			flowTask("T-1", "One"),
			flowRun("a", "task:T-1", 0, "needs_answer"),
		];
		const home = renderWith(
			{ runs: [activeRun({ taskId: "T-1" })], flowLive: { mfw: nodes } },
			() => createElement(HomePage),
		);
		const flow = renderToStaticMarkup(
			createElement(FlowLens, {
				nodes: nodes as never,
				spans: [],
				markers: [],
				filter: {},
				window: { from: Date.now() - 7_200_000, to: Date.now(), live: true },
				now: Date.now(),
				width: 1200,
				wide: true,
				selectedRef: null,
				overrides: new Map(),
				onToggle: () => {},
				onSelect: () => {},
			}),
		);
		// The row's own element, balanced, with the timeline's SVG left out.
		const row = (html: string) => {
			const key = html.indexOf('data-key="run:a"');
			expect(key).toBeGreaterThan(0);
			const open = html.lastIndexOf("<div", key);
			let depth = 0;
			let at = open;
			const tag = /<\/?div\b/g;
			tag.lastIndex = open;
			for (let m = tag.exec(html); m; m = tag.exec(html)) {
				depth += m[0] === "</div" ? -1 : 1;
				if (depth === 0) {
					at = html.indexOf(">", m.index) + 1;
					break;
				}
			}
			return html.slice(open, at).replace(/<svg[\s\S]*?<\/svg>/g, "");
		};
		const words = (el: string) =>
			el
				.replace(/<[^>]*>/g, " ")
				.replace(/\s+/g, " ")
				.trim();
		const label = (el: string) => /aria-label="([^"]*)"/.exec(el)?.[1];
		expect(words(row(home))).toBe(words(row(flow)));
		expect(words(row(home))).toContain("needs answer");
		expect(words(row(home))).toContain("CC");
		expect(label(row(home))).toContain("needs answer for 5 hours");
		expect(label(row(home))).toBe(label(row(flow)));
	});
});

describe("since you left", () => {
	test("Mark caught up advances each project's marker to its latest seq", () => {
		const written: Record<string, number> = {};
		const next = markCaughtUp(
			[
				{ project: "mfw", latestSeq: 90 },
				{ project: "jev", latestSeq: 12 },
			],
			(p, s) => {
				written[p] = s;
			},
		);
		expect(written).toEqual({ mfw: 90, jev: 12 });
		expect(next).toEqual(written);
	});

	test("projects that did not move collapse to a count", () => {
		const entry = { kind: "done", count: 1, taskIds: [], detail: "" };
		const moved = { project: "a", entries: [entry] };
		const quiet = { project: "b", entries: [] };
		const split = splitDigests([
			moved,
			quiet,
			{ ...quiet, project: "c" },
		] as never);
		expect(split.active.map((d) => d.project)).toEqual(["a"]);
		expect(split.quiet).toBe(2);
	});
});

describe("the Since-you-left histogram", () => {
	const MIN = 60_000;
	const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
	const h = { from: NOW - 120 * MIN, bucketMs: 30 * MIN };

	test("a bucket opens Flow at the end of that bucket", () => {
		const link = bucketLink("mfw", h, 1, NOW);
		expect(link).toContain("/p/mfw/flow");
		expect(link).toContain(
			`t=${new Date(NOW - 60 * MIN).toISOString().replace(/%3A/g, ":")}`,
		);
	});

	test("the last bucket has no past instant and opens the live Flow", () => {
		const link = bucketLink("mfw", h, 3, NOW);
		expect(link).toContain("/p/mfw/flow");
		expect(link).not.toContain("t=");
	});

	test("bars scale to the busiest bucket and a busy bucket is never invisible", () => {
		expect(barHeights([0, 1, 50])).toEqual([0, 0.08, 1]);
		expect(barHeights([0, 0])).toEqual([0, 0]);
	});

	test("one link per bucket, each carrying its count and its Flow target", () => {
		const html = renderToStaticMarkup(
			createElement(ActivityHistogram, {
				project: "mfw",
				histogram: { ...h, to: NOW, counts: [3, 0, 7, 1] },
				now: NOW,
			}),
		);
		expect((html.match(/<a /g) ?? []).length).toBe(4);
		expect(html).toContain("7 events");
		expect(html).toContain("1 event");
		expect(html).toContain("/p/mfw/flow?t=");
	});
});
