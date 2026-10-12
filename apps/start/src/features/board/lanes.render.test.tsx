import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppRouter } from "@mfw/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { renderToString } from "react-dom/server";
import { parseBoardLayout } from "../../lib/boardColumns";
import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import {
	Column,
	Lane,
	type LaneItem,
	LaneStack,
	LayoutToggle,
	TaskCard,
} from "./BoardPage";
import { BoardAgentsContext, boardAgents } from "./boardAgents";
import { type BoardColumn, boardColumns } from "./columns";
import { laneTile } from "./lanes";

process.env.BASE_URL ??= "/";

const PROJECT = "alpha";

const STATUSES = [
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
		priority: "medium",
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
	task("A", "backlog"),
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

function items(collapsed: string[] = []): LaneItem[] {
	return COLUMNS.map((column, i) => ({
		column,
		tasks: TASKS.filter((t) => t.status === column.role) as never,
		collapsed: collapsed.includes(column.value),
		previous: COLUMNS[i - 1],
		next: COLUMNS[i + 1],
	}));
}

const stack = (collapsed: string[] = [], selected: string | null = null) =>
	wrap(
		<LaneStack
			items={items(collapsed)}
			project={PROJECT}
			selectedTask={selected}
			height={700}
			onToggle={() => {}}
			onMoveAll={() => {}}
			onDrop={() => {}}
		/>,
	);

describe("the lanes layout", () => {
	test("every status is a lane with its header and its cards in one strip", () => {
		const html = stack();
		for (const column of COLUMNS) {
			expect(html).toContain(`aria-label="${column.label} lane"`);
		}
		expect(html.match(/data-lane-strip/g)).toHaveLength(COLUMNS.length);
		expect(html).toContain("Task A");
		expect(html).toContain("Task F");
		expect(html).toContain('aria-label="In progress: sort by activity"');
		expect(html).toContain('aria-label="Collapse In progress"');
		// the agent chip rides on the tile
		expect(html).toContain(">CC<");
		expect(html).toContain("waiting for the schema");
	});

	test("bulk-move arrows point along the stack: up and down, not left and right", () => {
		const html = stack();
		// The move buttons are the only chevron-up users; left/right ones would
		// mean the arrows still point across the lane.
		expect(html).toContain("lucide-chevron-up");
		expect(html).not.toContain("lucide-chevron-left");
	});

	test("lanes share the height: the tile height is measured from the stack", () => {
		const html = stack();
		const tile = Number(html.match(/data-tile-height="(\d+)"/)?.[1]);
		expect(tile).toBeGreaterThanOrEqual(68);
		expect(tile).toBeLessThanOrEqual(112);
		// Each lane takes what its titles need out of that budget (short titles: one line).
		expect(html).toContain(`height:${laneTile(tile, [])}px`);
	});

	test("a collapsed lane is one header row that still takes drops and says why it refuses", () => {
		const html = stack(["done", "in_progress"]);
		expect(html).toContain("Expand Done, 1 tasks");
		expect(html).toContain("Expand In progress, 1 tasks");
		expect(html).toContain("data-lane-collapsed");
		// in progress never takes a human drop: refused, with the reason on drop
		expect(html).toMatch(
			/aria-label="Expand In progress[^>]*data-drop="refused"|data-drop="refused"[^>]*aria-label="Expand In progress/,
		);
		expect(html.match(/data-lane-strip/g)).toHaveLength(COLUMNS.length - 2);
	});

	test("a scrubbed lane takes no drops and its tiles cannot be dragged", () => {
		const column = COLUMNS[1] as BoardColumn;
		const html = wrap(
			<Lane
				column={column}
				tasks={[task("B", "ready")] as never}
				collapsed={false}
				onToggle={() => {}}
				onMoveAll={() => {}}
				onDrop={() => {}}
				project={PROJECT}
				readOnly
				tile={80}
			/>,
		);
		expect(html).toContain('data-drop="readonly"');
		expect(html).not.toContain('draggable="true"');
	});

	test("a live lane's tiles are draggable; a claimed one is locked", () => {
		const html = stack();
		expect(html).toContain('draggable="true"');
		expect(html).toContain('draggable="false"');
	});

	test("the selected task is drawn selected and stays a card", () => {
		const html = stack([], "B");
		expect(html).toContain('data-selected="true"');
		expect(html.match(/data-selected="true"/g)).toHaveLength(1);
	});

	test("an empty lane that was opened stays empty, no placeholder text", () => {
		const html = wrap(
			<Lane
				column={COLUMNS[0] as BoardColumn}
				tasks={[]}
				collapsed={false}
				onToggle={() => {}}
				onMoveAll={() => {}}
				onDrop={() => {}}
				project={PROJECT}
				tile={80}
			/>,
		);
		expect(html).not.toContain("Nothing here");
	});

	test("the layout toggle names both layouts and marks the current one", () => {
		const html = renderToString(
			<LayoutToggle layout="lanes" onChange={() => {}} />,
		);
		expect(html).toContain("Lanes");
		expect(html).toContain("Columns");
		expect(html).toMatch(
			/aria-pressed="true"[^>]*>(?:<svg[^>]*><\/svg>|<svg[\s\S]*?<\/svg>)Lanes/,
		);
	});

	test("an unknown or missing stored layout falls back to lanes", () => {
		expect(parseBoardLayout(null)).toBe("lanes");
		expect(parseBoardLayout("wide")).toBe("lanes");
		expect(parseBoardLayout("columns")).toBe("columns");
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
					column={COLUMNS[2] as BoardColumn}
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
			wrap(
				<TaskCard
					task={task("C", "in_progress", { claimedByRunId: "R1" }) as never}
					project={PROJECT}
					draggable
					tile={{ height: 80 }}
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
