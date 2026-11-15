import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppRouter } from "@mfw/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { renderToString } from "react-dom/server";
import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import {
	Column,
	type GridItem,
	GridSection,
	GridStack,
	LayoutToggle,
	TaskCard,
} from "./BoardPage";
import { BoardAgentsContext, boardAgents } from "./boardAgents";
import { type BoardColumn, boardColumns } from "./columns";
import { GRID } from "./grid";

process.env.BASE_URL ??= "/";

const PROJECT = "alpha";

const STATUSES = [
	["draft", "Draft"],
	["backlog", "Backlog"],
	["ready", "Ready"],
	["in_progress", "In progress"],
	["blocked", "Blocked"],
	["review", "Review"],
	["done", "Done"],
].map(([role, label], order) => ({
	value: role as string,
	label: label as string,
	role: role as string,
	writable: true,
	terminal: role === "done",
	order,
}));
const COLUMNS = boardColumns(STATUSES);

function task(id: string, status: string, over: Record<string, unknown> = {}) {
	return {
		id,
		title: `Task ${id}`,
		type: "implementation",
		priority: "high",
		size: "s",
		labels: ["api"],
		dependsOn: [] as string[],
		status,
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

const TASKS = [
	task("A", "backlog", { dependsOn: ["Z"] }),
	task("A2", "backlog"),
	task("A3", "backlog"),
	task("B", "ready"),
	task("C", "in_progress", { claimedByRunId: "R1" }),
	task("D", "blocked", { blockedReason: "waiting for the schema" }),
	task("E", "review"),
	task("F", "done"),
];

function wrap(node: React.ReactNode) {
	const link: TRPCLink<AppRouter> =
		() =>
		({ op }) =>
			observable((observer) => {
				observer.error(new Error(`no network: ${op.path}`) as never);
			});
	const client = createTRPCClient<AppRouter>({ links: [link] });
	const queryClient = new QueryClient();
	const agents = boardAgents(
		PROJECT,
		[
			{
				project: PROJECT,
				runId: "R1",
				state: "running",
				taskId: "C",
				activity: "working",
				providerId: "claude-cli",
				model: "claude-opus-4-5",
				startedAt: Date.now() - 60_000,
			},
			{
				project: PROJECT,
				runId: "R2",
				state: "running",
				taskId: "E",
				activity: "stalled",
				providerId: "claude-cli",
				model: "claude-opus-4-5",
				startedAt: Date.now() - 60_000,
			},
		],
		[],
		{ E: [{ ref: "run:OLD", glyph: "fail" }] },
	);
	return renderToString(
		<ToastProvider>
			<QueryClientProvider client={queryClient}>
				<TRPCProvider trpcClient={client} queryClient={queryClient}>
					<BoardAgentsContext.Provider value={agents}>
						{node}
					</BoardAgentsContext.Provider>
				</TRPCProvider>
			</QueryClientProvider>
		</ToastProvider>,
	);
}

function items(collapsed: string[] = []): GridItem[] {
	return COLUMNS.map((column, i) => ({
		column,
		tasks: TASKS.filter((t) => t.status === column.role) as never,
		collapsed: collapsed.includes(column.value),
		previous: COLUMNS[i - 1],
		next: COLUMNS[i + 1],
	}));
}

const stack = (
	collapsed: string[] = [],
	selected: string | null = null,
	readOnly = false,
) =>
	wrap(
		<GridStack
			items={items(collapsed)}
			project={PROJECT}
			selectedTask={selected}
			readOnly={readOnly}
			onToggle={() => {}}
			onMoveAll={() => {}}
			onDrop={() => {}}
		/>,
	);

const section = (
	column: BoardColumn,
	tasks: ReturnType<typeof task>[],
	over: { collapsed?: boolean; readOnly?: boolean } = {},
) =>
	wrap(
		<GridSection
			column={column}
			tasks={tasks as never}
			collapsed={over.collapsed ?? false}
			onToggle={() => {}}
			onMoveAll={() => {}}
			onDrop={() => {}}
			project={PROJECT}
			readOnly={over.readOnly ?? false}
		/>,
	);

const byRole = (role: string) =>
	COLUMNS.find((c) => c.role === role) as BoardColumn;

/** The opening tag of the element carrying `attr`, for asserting its own classes and styles. */
const tagWith = (html: string, attr: string) =>
	html.match(new RegExp(`<[^>]*${attr}[^>]*>`, "g")) ?? [];

describe("the grid layout", () => {
	test("every status with tasks is a section with its header and its cards in a grid body", () => {
		const html = stack();
		for (const column of COLUMNS.filter((c) => c.role !== "draft")) {
			expect(html).toContain(`aria-label="${column.label} section"`);
		}
		// the empty draft section is open (nothing collapsed it) but has no body
		expect(html.match(/data-grid-body/g)).toHaveLength(COLUMNS.length - 1);
		for (const id of ["A", "A2", "A3", "B", "C", "D", "E", "F"]) {
			expect(html).toContain(`data-task="${id}"`);
		}
	});

	test("cards wrap in a CSS grid of as many columns as fit; the stack scrolls vertically only", () => {
		const html = stack();
		const bodies = tagWith(html, "data-grid-body");
		expect(bodies.length).toBeGreaterThan(0);
		for (const body of bodies) {
			expect(body).toContain('class="grid');
			expect(body).toContain(
				`grid-template-columns:repeat(auto-fill, minmax(min(100%, ${GRID.MIN_CARD_W}px), 1fr))`,
			);
		}
		const [stackTag] = tagWith(html, "data-grid-stack");
		expect(stackTag).toContain("overflow-y-auto");
		expect(stackTag).toContain("overflow-x-hidden");
		// Nothing in this layout scrolls sideways.
		expect(html).not.toContain("overflow-x-auto");
		expect(html).not.toContain("overflow-x-scroll");
		expect(html).not.toContain("data-lane");
	});

	test("the cells are the full columns card: type, priority, deps, labels, agents", () => {
		const html = stack();
		expect(html).toContain(">implementation<");
		expect(html).toMatch(/>1(<!-- -->)? deps</);
		expect(html).toContain(">api<");
		expect(html).toContain("project checks");
		expect(html).toContain("waiting for the schema");
		// the agent chip rides on the card
		expect(html).toContain(">CC<");
		expect(html).not.toContain('aria-label="Expand A"');
		expect(html).not.toContain("data-tile");
	});

	test("every open header has the view switches, the collapse button and one closed bulk-move menu", () => {
		const html = stack();
		for (const label of ["Backlog", "Ready", "In progress", "Review"]) {
			expect(html).toContain(`aria-label="${label}: move all tasks"`);
			expect(html).toContain(`aria-label="${label}: only with agents"`);
			expect(html).toContain(`aria-label="${label}: sort by activity"`);
			expect(html).toContain(`aria-label="Collapse ${label}"`);
		}
		// A stray click on a header must never move a whole status.
		expect(html).not.toContain('role="menu"');
		expect(html).toContain("move all tasks");
	});

	test("the header carries the status icon, label, count and the live and needs-you signals", () => {
		const html = section(byRole("in_progress"), [
			task("C", "in_progress", { claimedByRunId: "R1" }),
		]);
		expect(html).toContain(">In progress<");
		expect(html).toContain('aria-label="1 live run"');
		const review = section(byRole("review"), [task("E", "review")]);
		expect(review).toContain('aria-label="1 task needs you"');
		// and the card itself wears the needs-you ring
		expect(review).toContain("box-shadow:0 0 0 2px var(--mfw-warn)");
	});

	test("a collapsed section is one header row that still takes drops and says why it refuses", () => {
		const html = stack(["done", "in_progress"]);
		expect(html).toContain("Expand Done, 1 tasks");
		expect(html).toContain("Expand In progress, 1 tasks");
		expect(html.match(/data-grid-collapsed/g)).toHaveLength(2);
		// in progress never takes a human drop: refused, with the reason on drop
		expect(html).toMatch(
			/aria-label="Expand In progress[^>]*data-drop="refused"|data-drop="refused"[^>]*aria-label="Expand In progress/,
		);
		expect(html.match(/data-grid-body/g)).toHaveLength(COLUMNS.length - 3);
		expect(html).not.toContain('data-task="F"');
	});

	test("an open section refuses drops where the board never takes them", () => {
		const html = stack();
		expect(html).toMatch(
			/aria-label="In progress section"[^>]*data-drop="refused"/,
		);
		expect(html).toMatch(/aria-label="Ready section"[^>]*data-drop="open"/);
	});

	test("an empty section that was opened is its header alone: no menu, no placeholder", () => {
		const html = section(byRole("backlog"), []);
		expect(html).toContain('aria-label="Backlog section"');
		expect(html).not.toContain("data-grid-body");
		expect(html).not.toContain("move all tasks");
		expect(html).not.toContain("Nothing here");
	});

	test("a scrubbed board takes no drops, drags nothing and offers no bulk move", () => {
		const html = stack([], null, true);
		expect(html).toContain('data-drop="readonly"');
		expect(html).not.toContain('data-drop="open"');
		expect(html).not.toContain('draggable="true"');
		expect(
			section(byRole("ready"), [task("B", "ready")], { readOnly: true }),
		).toMatch(
			/aria-label="Ready: move all tasks"[^>]*disabled|disabled[^>]*aria-label="Ready: move all tasks"/,
		);
	});

	test("a live section's cards are draggable; a claimed one is locked", () => {
		const html = stack();
		expect(html).toMatch(/data-task="B"[^>]*draggable="true"/);
		expect(html).toMatch(/data-task="C"[^>]*draggable="false"/);
	});

	test("the selected task is drawn selected, once", () => {
		const html = stack([], "B");
		expect(html.match(/data-selected="true"/g)).toHaveLength(1);
		expect(html).toMatch(/data-task="B"[^>]*data-selected="true"/);
	});

	test("the layout toggle names both layouts and marks the current one", () => {
		const html = renderToString(
			<LayoutToggle layout="grid" onChange={() => {}} />,
		);
		expect(html).toContain("Grid");
		expect(html).toContain("Columns");
		expect(html).not.toContain("Lanes");
		expect(html).toMatch(
			/aria-pressed="true"[^>]*>(?:<svg[^>]*><\/svg>|<svg[\s\S]*?<\/svg>)Grid/,
		);
	});
});

describe("nothing on the board moves", () => {
	const MOTION = /animate-|mfw-pulse|animation|@keyframes/;

	function everything() {
		return [
			stack(),
			stack(["done"], "C"),
			wrap(
				<Column
					column={COLUMNS[3] as BoardColumn}
					tasks={[task("C", "in_progress", { claimedByRunId: "R1" })] as never}
					collapsed={false}
					onToggle={() => {}}
					onMoveAll={() => {}}
					onDrop={() => {}}
					project={PROJECT}
				/>,
			),
			wrap(
				<TaskCard
					task={task("C", "in_progress", { claimedByRunId: "R1" }) as never}
					project={PROJECT}
					draggable
					defaultExpanded
				/>,
			),
		];
	}

	test("no rendered board element carries an animation class or style, in either layout", () => {
		for (const html of everything()) {
			expect(html).not.toMatch(MOTION);
		}
	});

	test("a live run is told by shape, colour and label", () => {
		const html = stack();
		expect(html).toContain('aria-label="working"');
		expect(html).toContain('data-glyph="dot"');
	});

	test("the board's sources and the icon vocabulary carry no pulse or animate", () => {
		const root = join(import.meta.dir, "..", "..");
		const dirs = [
			join(root, "features", "board"),
			join(root, "components", "icons"),
			join(root, "components", "agent"),
		];
		for (const dir of dirs) {
			for (const name of readdirSync(dir)) {
				if (!/\.(ts|tsx)$/.test(name) || /\.test\./.test(name)) continue;
				const text = readFileSync(join(dir, name), "utf8");
				expect(
					`${name}: ${/\bpulse\b|mfw-pulse|animate-|animation/.test(text)}`,
				).toBe(`${name}: false`);
			}
		}
	});
});
