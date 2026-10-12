import { describe, expect, test } from "bun:test";
import type { AppRouter } from "@mfw/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { renderToString } from "react-dom/server";

import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import { BoardPage, Column, filterBoardTasks, TaskCard } from "./BoardPage";
import { BoardAgentsContext, boardAgents } from "./boardAgents";
import { boardAgentsAt, tasksAt } from "./boardAt";
import { type BoardColumn, boardColumns } from "./columns";

// Vite provides BASE_URL (AppLink reads it); bun test does not.
process.env.BASE_URL ??= "/";

const PROJECT = "alpha";

function harness() {
	// Nothing may hit the network in a render test: every call would fail loudly.
	const calls: string[] = [];
	const link: TRPCLink<AppRouter> =
		() =>
		({ op }) =>
			observable((observer) => {
				calls.push(op.path);
				observer.error(new Error("no network in a render test") as never);
			});
	const client = createTRPCClient<AppRouter>({ links: [link] });
	const queryClient = new QueryClient();
	const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
	return { calls, client, queryClient, trpc };
}

function task(id: string, over: Record<string, unknown> = {}) {
	return {
		id,
		title: `Task ${id}`,
		type: "implementation",
		priority: "medium",
		size: null,
		labels: [] as string[],
		dependsOn: [] as string[],
		status: "ready",
		statusChangedAt: new Date(0),
		blockedReason: null,
		verification: null,
		draftPhase: null,
		draftAttempts: 0,
		afterExpansion: "ready",
		claimedByRunId: null,
		claimedAt: null,
		...over,
	};
}

const KANBAN = [
	{
		value: "todo",
		label: "Todo",
		role: "ready",
		writable: true,
		terminal: false,
		order: 0,
	},
	{
		value: "doing",
		label: "Doing",
		role: "in_progress",
		writable: true,
		terminal: false,
		order: 1,
	},
	{
		value: "review",
		label: "Review",
		role: "review",
		writable: true,
		terminal: false,
		order: 2,
	},
	{
		value: "done",
		label: "Done",
		role: "done",
		writable: true,
		terminal: true,
		order: 3,
	},
];

describe("BoardPage reads its agent facts once per board", () => {
	test("20 cards add no per-card queries: one cache entry each for active runs, questions, pips, verdicts", () => {
		const h = harness();
		const tasks = Array.from({ length: 20 }, (_, i) => task(`MFW-${i + 1}`));
		const set = <T,>(key: readonly unknown[], data: T) =>
			h.queryClient.setQueryData(key, data);
		set(h.trpc.tasks.list.queryKey({ project: PROJECT }), tasks);
		set(h.trpc.board.schema.queryKey({ project: PROJECT }), {
			statuses: KANBAN,
			types: [],
			hierarchy: null,
			layout: "flat",
		});
		set(h.trpc.runs.active.queryKey(), [
			{
				project: PROJECT,
				runId: "R1",
				kind: "task",
				state: "running",
				taskId: "MFW-1",
				providerId: "claude-cli",
				model: "claude-opus-4-5",
				startedAt: Date.now() - 60_000,
				activity: "working",
				activityDetail: null,
				scopeSample: null,
			},
		]);
		set(h.trpc.clarify.open.queryKey(), []);
		set(h.trpc.runs.pipsByTask.queryKey({ project: PROJECT }), {
			"MFW-2": [{ ref: "run:OLD", glyph: "fail" }],
		});

		const html = renderToString(
			<ToastProvider>
				<QueryClientProvider client={h.queryClient}>
					<TRPCProvider trpcClient={h.client} queryClient={h.queryClient}>
						<BoardPage project={PROJECT} filters={{}} onFilters={() => {}} />
					</TRPCProvider>
				</QueryClientProvider>
			</ToastProvider>,
		);

		// The cards are drawn from those caches.
		expect(html).toContain("Task MFW-20");
		expect(html).toContain(">CC<");
		expect(html).toContain("opus");
		expect(html).toContain('aria-label="failed: run:OLD"');

		// The board's queries: each of ours exactly once, none keyed by a task.
		const paths = h.queryClient
			.getQueryCache()
			.getAll()
			.map((q) => (q.queryKey[0] as string[]).join("."));
		for (const path of [
			"runs.active",
			"clarify.open",
			"runs.pipsByTask",
			"review.latestVerdicts",
			"board.schema",
		]) {
			expect(paths.filter((p) => p === path)).toHaveLength(1);
		}
		const perTask = paths.filter((p) =>
			["tasks.get", "runs.list", "runs.get", "review.verdicts"].includes(p),
		);
		expect(perTask).toEqual([]);
		// No fetch happened for what the cache already answered.
		expect(h.calls).not.toContain("runs.active");
		expect(h.calls).not.toContain("runs.pipsByTask");
	});
});

describe("column header", () => {
	const columns = boardColumns(KANBAN);
	const doing = columns[1] as BoardColumn;

	function renderColumn(
		collapsed: boolean,
		tasks: ReturnType<typeof task>[],
		readOnly = false,
	) {
		const h = harness();
		const agents = boardAgents(
			PROJECT,
			[
				{
					project: PROJECT,
					runId: "R1",
					state: "running",
					taskId: "A",
					activity: "working",
				},
				{
					project: PROJECT,
					runId: "R2",
					state: "running",
					taskId: "B",
					activity: "stalled",
				},
			],
			[],
		);
		return renderToString(
			<ToastProvider>
				<QueryClientProvider client={h.queryClient}>
					<TRPCProvider trpcClient={h.client} queryClient={h.queryClient}>
						<BoardAgentsContext.Provider value={agents}>
							<Column
								column={doing}
								tasks={tasks as never}
								collapsed={collapsed}
								onToggle={() => {}}
								onMoveAll={() => {}}
								onDrop={() => {}}
								project={PROJECT}
								readOnly={readOnly}
							/>
						</BoardAgentsContext.Provider>
					</TRPCProvider>
				</QueryClientProvider>
			</ToastProvider>,
		);
	}

	const tasks = [
		task("A", { status: "in_progress", claimedByRunId: "R1" }),
		task("B", { status: "in_progress", claimedByRunId: "R2" }),
		task("C", { status: "in_progress" }),
	];

	test("shows the board's own name and status icon, with live and needs-you counts", () => {
		const html = renderColumn(false, tasks);
		expect(html).toContain("Doing");
		expect(html).toContain('aria-label="Doing"');
		expect(html).toContain('aria-label="2 live runs"');
		expect(html).toContain('aria-label="1 task needs you"');
		expect(html).toContain("var(--mfw-status-in-progress)");
	});

	test("a column nothing runs in shows no signal counts", () => {
		const html = renderColumn(false, [task("C", { status: "in_progress" })]);
		expect(html).not.toContain("live run");
		expect(html).not.toContain("needs you");
	});

	test("a collapsed column keeps its icon, name, count and the needs-you flag", () => {
		const html = renderColumn(true, tasks);
		expect(html).toContain("Expand Doing, 3 tasks");
		expect(html).toContain('aria-label="1 task needs you"');
		expect(html).toContain('aria-expanded="false"');
	});

	test("a column that cannot take drops is marked refused", () => {
		expect(renderColumn(false, tasks)).toContain('data-drop="refused"');
	});

	test("a scrubbed column takes no drops and its cards cannot be dragged", () => {
		const live = renderColumn(false, tasks);
		expect(live).toContain('draggable="true"');
		const past = renderColumn(false, tasks, true);
		expect(past).toContain('data-drop="readonly"');
		expect(past).not.toContain('draggable="true"');
		expect(past).toContain('draggable="false"');
	});
});

describe("board header and cards", () => {
	function renderBoard(
		tasks: ReturnType<typeof task>[],
		filters: Record<string, string> = {},
		active: unknown[] = [],
	) {
		const h = harness();
		const set = <T,>(key: readonly unknown[], data: T) =>
			h.queryClient.setQueryData(key, data);
		set(h.trpc.tasks.list.queryKey({ project: PROJECT }), tasks);
		set(h.trpc.board.schema.queryKey({ project: PROJECT }), {
			statuses: KANBAN,
			types: [],
			hierarchy: null,
			layout: "flat",
		});
		set(h.trpc.runs.active.queryKey(), active);
		set(h.trpc.clarify.open.queryKey(), []);
		set(h.trpc.runs.pipsByTask.queryKey({ project: PROJECT }), {});
		return renderToString(
			<ToastProvider>
				<QueryClientProvider client={h.queryClient}>
					<TRPCProvider trpcClient={h.client} queryClient={h.queryClient}>
						<BoardPage
							project={PROJECT}
							filters={filters}
							onFilters={() => {}}
						/>
					</TRPCProvider>
				</QueryClientProvider>
			</ToastProvider>,
		).replaceAll("<!-- -->", "");
	}

	const mixed = [
		task("R-1", { status: "review" }),
		task("R-2", { status: "review" }),
		task("T-1", { status: "ready" }),
	];

	test("the header counts tasks waiting on review", () => {
		const html = renderBoard(mixed);
		expect(html).toContain("2 to review");
		expect(html).toContain('aria-pressed="false"');
	});

	test("no chip when nothing waits on review", () => {
		expect(renderBoard([task("T-1")])).not.toContain("to review");
	});

	test("the gate:review filter keeps only tasks awaiting review", () => {
		const kept = filterBoardTasks(mixed as never[], { gate: "review" });
		expect((kept as { id: string }[]).map((t) => t.id)).toEqual(["R-1", "R-2"]);
		expect(filterBoardTasks(mixed as never[], {})).toHaveLength(3);
		// The chip shows it is on.
		const html = renderBoard(mixed, { gate: "review" });
		expect(html).toContain('aria-pressed="true"');
		expect(html).toContain("Clear");
	});

	test("the working chip links to the run that claims the task", () => {
		const h = harness();
		const agents = boardAgents(
			PROJECT,
			[
				{
					project: PROJECT,
					runId: "RUN-CLAIM",
					state: "running",
					// Not attributed by task: the card finds it through its claim.
					taskId: null,
					providerId: "claude-cli",
					model: "claude-opus-4-5",
					startedAt: Date.now() - 60_000,
					activity: "working",
				},
			],
			[],
		);
		const html = renderToString(
			<ToastProvider>
				<QueryClientProvider client={h.queryClient}>
					<TRPCProvider trpcClient={h.client} queryClient={h.queryClient}>
						<BoardAgentsContext.Provider value={agents}>
							<TaskCard
								task={
									task("T-1", {
										status: "in_progress",
										claimedByRunId: "RUN-CLAIM",
									}) as never
								}
								project={PROJECT}
								draggable
							/>
						</BoardAgentsContext.Provider>
					</TRPCProvider>
				</QueryClientProvider>
			</ToastProvider>,
		);
		expect(html).toContain('href="/p/alpha/runs/RUN-CLAIM"');
		expect(html).toContain('aria-label="working"');
	});

	test("every column has a menu with the agents switches, closed by default", () => {
		const h = harness();
		const doing = boardColumns(KANBAN)[1] as BoardColumn;
		const html = renderToString(
			<ToastProvider>
				<QueryClientProvider client={h.queryClient}>
					<TRPCProvider trpcClient={h.client} queryClient={h.queryClient}>
						<Column
							column={doing}
							tasks={[]}
							collapsed={false}
							onToggle={() => {}}
							onMoveAll={() => {}}
							onDrop={() => {}}
							project={PROJECT}
						/>
					</TRPCProvider>
				</QueryClientProvider>
			</ToastProvider>,
		);
		expect(html).toContain('aria-label="Doing: only with agents"');
		expect(html).toContain('aria-label="Doing: sort by activity"');
		expect(html).not.toContain("aria-haspopup");
	});
});

describe("board at t (read-only)", () => {
	const AT = "2020-01-01T00:00:00.000Z";

	function atNode(id: string, status: string) {
		return {
			ref: `task:${id}`,
			parent: null,
			kind: "task",
			title: id,
			status: { value: status, role: status },
			needsMe: null,
			lastAt: new Date(0),
		};
	}

	function renderAt(
		live: ReturnType<typeof task>[],
		nodes: ReturnType<typeof atNode>[],
		extra: unknown[] = [],
	) {
		const h = harness();
		const set = <T,>(key: readonly unknown[], data: T) =>
			h.queryClient.setQueryData(key, data);
		set(h.trpc.tasks.list.queryKey({ project: PROJECT }), live);
		set(h.trpc.board.schema.queryKey({ project: PROJECT }), {
			statuses: KANBAN,
			types: [],
			hierarchy: null,
			layout: "flat",
		});
		set(h.trpc.runs.active.queryKey(), []);
		set(h.trpc.clarify.open.queryKey(), []);
		set(h.trpc.runs.pipsByTask.queryKey({ project: PROJECT }), {});
		set(
			h.trpc.flow.at.queryKey({
				project: PROJECT,
				t: new Date(AT),
			}),
			{ nodes: [...nodes, ...extra], seq: 1, t: new Date(AT) },
		);
		return renderToString(
			<ToastProvider>
				<QueryClientProvider client={h.queryClient}>
					<TRPCProvider trpcClient={h.client} queryClient={h.queryClient}>
						<BoardPage
							project={PROJECT}
							filters={{}}
							onFilters={() => {}}
							at={AT}
						/>
					</TRPCProvider>
				</QueryClientProvider>
			</ToastProvider>,
		).replaceAll("<!-- -->", "");
	}

	// Currently both are done; at t, A was in review and B did not exist yet.
	const live = [task("A", { status: "done" }), task("B", { status: "done" })];
	const nodes = [atNode("A", "review")];

	test("cards sit in the column they had at t; later tasks are absent", () => {
		const html = renderAt(live, nodes);
		// Both tasks are done now; at t one was in review and one did not exist.
		expect(html).toContain("Review 1</button>");
		expect(html).toContain("Done 0</button>");
	});

	test("read-only: a banner, nothing to create, no per-card moves", () => {
		const html = renderAt([task("A", { status: "review" })], nodes);
		expect(html).toContain("data-scrub-banner");
		expect(html).toContain("Back to live (L)");
		expect(html).not.toContain("Create task");
		expect(html).not.toContain('draggable="true"');
		expect(html).not.toContain('aria-label="Move A"');
	});

	test("live board still drags", () => {
		const h = harness();
		const set = <T,>(key: readonly unknown[], data: T) =>
			h.queryClient.setQueryData(key, data);
		set(h.trpc.tasks.list.queryKey({ project: PROJECT }), [task("A")]);
		set(h.trpc.board.schema.queryKey({ project: PROJECT }), {
			statuses: KANBAN,
			types: [],
			hierarchy: null,
			layout: "flat",
		});
		set(h.trpc.runs.active.queryKey(), []);
		set(h.trpc.clarify.open.queryKey(), []);
		set(h.trpc.runs.pipsByTask.queryKey({ project: PROJECT }), {});
		const html = renderToString(
			<ToastProvider>
				<QueryClientProvider client={h.queryClient}>
					<TRPCProvider trpcClient={h.client} queryClient={h.queryClient}>
						<BoardPage project={PROJECT} filters={{}} onFilters={() => {}} />
					</TRPCProvider>
				</QueryClientProvider>
			</ToastProvider>,
		);
		expect(html).toContain('aria-label="Move A"');
		expect(html).toContain("Create task");
		expect(html).not.toContain("data-scrub-banner");
	});
});

describe("boardAt", () => {
	test("tasksAt drops tasks that did not exist and carries the status then", () => {
		const out = tasksAt(
			[
				{ id: "A", status: "done" },
				{ id: "B", status: "done" },
			],
			[
				{
					ref: "task:A",
					parent: null,
					kind: "task",
					status: { value: "review" },
				},
			],
		);
		expect(out).toEqual([{ id: "A", status: "review" }]);
	});

	test("agents at t: live runs reach their task through the chain, pips come along", () => {
		const agents = boardAgentsAt("p", [
			{
				ref: "task:A",
				parent: null,
				kind: "task",
				status: { value: "in_progress" },
				historyPips: [{ ref: "run:old", glyph: "fail" }],
			},
			{
				ref: "run:r1",
				parent: "task:A",
				kind: "run",
				run: {
					state: "failed",
					activity: null,
					harness: "claude-cli",
					model: "m",
					startedAt: new Date(1),
					liveCostUsd: null,
				},
			},
			{
				ref: "run:r2",
				parent: "run:r1",
				kind: "run",
				run: {
					state: "running",
					activity: "working",
					harness: "claude-cli",
					model: "m",
					startedAt: new Date(2),
					liveCostUsd: null,
				},
			},
		]);
		expect([...agents.runs.keys()]).toEqual(["r2"]);
		expect(agents.byTask.get("A")?.map((r) => r.runId)).toEqual(["r2"]);
		expect(agents.pips.A).toEqual([{ ref: "run:old", glyph: "fail" }]);
	});
});
