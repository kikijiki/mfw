import { describe, expect, test } from "bun:test";
import type { FlowMarker, FlowSpan } from "@mfw/daemon/flow";
import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Vite provides BASE_URL (AppLink reads it); bun test does not.
process.env.BASE_URL ??= "/";

import { TipButton } from "~/components/ui/tooltip";
import { FlowLegend, LegendBody } from "./FlowLegend";
import { FlowLens, legendEntries, timelineWidth } from "./FlowPage";
import { buildFlow, type FlowNodeIn, type FlowRow } from "./flowModel";
import { MARK_LOOK, MARK_ORDER } from "./marks";
import { NodeRow, rowAccessibleName, spokenDuration } from "./NodeRow";
import { TimeControls } from "./TimeHeader";
import { cellModel, MarkButton, TimelineCell } from "./TimelineCell";
import { keyboardStep, rowDomId, TreeGrid } from "./TreeGrid";
import { makeScale, resolveWindow } from "./timeScale";

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

function task(id: string, over: Partial<FlowNodeIn> = {}): FlowNodeIn {
	return {
		ref: `task:${id}`,
		parent: null,
		kind: "task",
		title: `Title ${id}`,
		status: { value: "in_progress", role: "in_progress" },
		needsMe: null,
		lastAt: new Date(NOW),
		...over,
	} as FlowNodeIn;
}

function run(
	id: string,
	parent: string | null,
	over: {
		state?: string;
		activity?: string | null;
		startedAgo?: number;
		harness?: string;
		model?: string;
		needsMe?: FlowNodeIn["needsMe"];
	} = {},
): FlowNodeIn {
	return {
		ref: `run:${id}`,
		parent,
		kind: "run",
		title: id,
		needsMe: over.needsMe ?? null,
		lastAt: new Date(NOW),
		run: {
			role: "worker",
			relation: "fresh",
			state: over.state ?? "running",
			activity: over.activity ?? "working",
			harness: over.harness ?? "claude-cli",
			model: over.model ?? "claude-opus-4-5",
			effort: null,
			host: null,
			label: id,
			startedAt: new Date(NOW - (over.startedAgo ?? 12 * MIN)),
			finishedAt: null,
			costUsd: null,
			liveCostUsd: null,
		},
	} as FlowNodeIn;
}

const span = (
	subject: string,
	lane: string,
	value: string,
	startAgo: number,
	endAgo: number | null,
	detail?: Record<string, unknown>,
): FlowSpan => ({
	subject,
	lane,
	value,
	start: new Date(NOW - startAgo),
	end: endAgo === null ? null : new Date(NOW - endAgo),
	...(detail ? { detail } : {}),
});

const marker = (
	subject: string,
	kind: FlowMarker["kind"],
	ago: number,
	ref: string,
): FlowMarker => ({
	subject,
	at: new Date(NOW - ago),
	kind,
	ref,
	label: `${kind} label`,
});

const NODES: FlowNodeIn[] = [
	task("E", { kind: "epic" }),
	task("A", { parent: "task:E" }),
	task("B", { parent: "task:E" }),
	run("r1", "task:A", {
		activity: "needs_answer",
		needsMe: "question",
		harness: "codex-cli",
		model: "gpt-5",
		startedAgo: 3 * MIN,
	}),
];

function lens(over: Partial<Parameters<typeof FlowLens>[0]> = {}) {
	return (
		<FlowLens
			nodes={NODES}
			spans={[]}
			markers={[]}
			filter={{}}
			window={resolveWindow({ w: "2h", now: NOW })}
			now={NOW}
			width={1200}
			wide
			selectedRef={null}
			overrides={new Map()}
			onToggle={() => {}}
			onSelect={() => {}}
			{...over}
		/>
	);
}

describe("treegrid semantics", () => {
	test("rows carry level, expanded, set position and a name", () => {
		const html = renderToStaticMarkup(
			lens({ overrides: new Map([["task:E", true]]) }),
		);
		expect(html).toContain('role="treegrid"');
		// the epic is open at level 1; its children are level 2
		const epic = /<div[^>]*data-key="task:E"[^>]*>/.exec(html)?.[0] ?? "";
		expect(epic).toContain('role="row"');
		expect(epic).toContain('aria-level="1"');
		expect(epic).toContain('aria-expanded="true"');
		const a = /<div[^>]*data-key="task:A"[^>]*>/.exec(html)?.[0] ?? "";
		expect(a).toContain('aria-level="2"');
		expect(a).toContain('aria-posinset="1"');
		expect(a).toContain('aria-setsize="2"');
		// A holds a live run, so it is open by default; B is a leaf with no state
		expect(a).toContain('aria-expanded="true"');
		const b = /<div[^>]*data-key="task:B"[^>]*>/.exec(html)?.[0] ?? "";
		expect(b).not.toContain("aria-expanded");
	});

	test("a closed row says so", () => {
		const html = renderToStaticMarkup(lens());
		const epic = /<div[^>]*data-key="task:E"[^>]*>/.exec(html)?.[0] ?? "";
		// a live run below opens its ancestors by default
		expect(epic).toContain('aria-expanded="true"');
		const closed = renderToStaticMarkup(
			lens({ overrides: new Map([["task:E", false]]) }),
		);
		const e2 = /<div[^>]*data-key="task:E"[^>]*>/.exec(closed)?.[0] ?? "";
		expect(e2).toContain('aria-expanded="false"');
		expect(closed).not.toContain('data-key="task:A"');
	});

	test("the selected node is aria-selected", () => {
		const html = renderToStaticMarkup(lens({ selectedRef: "task:A" }));
		const a = /<div[^>]*data-key="task:A"[^>]*>/.exec(html)?.[0] ?? "";
		expect(a).toContain('aria-selected="true"');
		const b = /<div[^>]*data-key="task:B"[^>]*>/.exec(html)?.[0] ?? "";
		expect(b).toContain('aria-selected="false"');
	});

	test("a row's name has its state and how long", () => {
		const view = buildFlow(NODES);
		const row = view.rows.find((r) => r.key === "run:r1") as FlowRow;
		expect(rowAccessibleName(row, NOW)).toBe(
			"r1, codex-cli gpt-5, needs answer for 3 minutes",
		);
		const html = renderToStaticMarkup(lens());
		expect(html).toContain(
			'aria-label="r1, codex-cli gpt-5, needs answer for 3 minutes"',
		);
		expect(spokenDuration(59_000)).toBe("under a minute");
		expect(spokenDuration(HOUR)).toBe("1 hour");
	});

	test("timeline cells are hidden from assistive tech", () => {
		const html = renderToStaticMarkup(lens());
		const cells = html.match(/<svg[^>]*data-timeline-cell[^>]*>/g) ?? [];
		expect(cells.length).toBeGreaterThan(0);
		for (const c of cells) expect(c).toContain('aria-hidden="true"');
	});
});

describe("only visible rows mount", () => {
	test("5,000 rows render a window of them, but report the count", () => {
		const rows: FlowRow[] = Array.from({ length: 5000 }, (_, i) => ({
			key: `task:T${i}`,
			kind: "node" as const,
			node: task(`T${i}`),
			depth: 0,
			expandable: false,
			expanded: false,
			dim: false,
			posInSet: i + 1,
			setSize: 5000,
			parentKey: null,
			active: false,
		}));
		const html = renderToStaticMarkup(
			<TreeGrid
				rows={rows}
				label="Work tree"
				renderRow={(row, ctx) => <NodeRow row={row} now={NOW} id={ctx.id} />}
				onToggle={() => {}}
				onSelect={() => {}}
			/>,
		);
		const mounted = (html.match(/role="row"/g) ?? []).length;
		expect(mounted).toBeGreaterThan(5);
		expect(mounted).toBeLessThan(100);
		expect(html).toContain('aria-rowcount="5000"');
		// the first row is there, the last is not
		expect(html).toContain('data-key="task:T0"');
		expect(html).not.toContain('data-key="task:T4999"');
	});
});

describe("phone layout", () => {
	test("hides the timeline column and draws a 40px sparkline per row", () => {
		const html = renderToStaticMarkup(lens({ wide: false, width: 390 }));
		expect(html).toContain('data-layout="phone"');
		expect(html).not.toContain("data-time-axis");
		expect(html).not.toContain('aria-label="Legend"');
		const cells = html.match(/<svg[^>]*data-timeline-cell[^>]*>/g) ?? [];
		expect(cells.length).toBeGreaterThan(0);
		for (const c of cells) expect(c).toContain('width="40"');
	});

	test("desktop has the axis and the legend, and the timeline fills what the tree leaves", () => {
		const html = renderToStaticMarkup(lens());
		expect(html).toContain('data-layout="wide"');
		expect(html).toContain("data-time-axis");
		// the legend is a "?" popover in the toolbar, not a permanent bar
		expect(html).not.toContain('aria-label="Legend"');
		expect(timelineWidth(1200)).toBe(820);
		expect(timelineWidth(500)).toBe(200);
		expect(timelineWidth(5000)).toBe(960);
		expect(html).toContain(`width="${timelineWidth(1200)}"`);
	});

	test("legend carries bars and marks, and names exactly the marks the timeline draws", () => {
		const entries = legendEntries();
		const labels = entries.map((e) => e.label);
		expect(labels).toContain("working");
		expect(labels).toContain("needs answer / approval");
		expect(labels).toContain("brain decision");
		expect(labels).toContain("merge");
		// single source of truth: every mark kind is in the legend, once
		const marks = entries.flatMap((e) => (e.kind === "mark" ? [e.mark] : []));
		expect([...marks].sort()).toEqual([...MARK_ORDER].sort());
		expect([...marks].sort() as string[]).toEqual(
			Object.keys(MARK_LOOK).sort(),
		);
		const html = renderToStaticMarkup(<LegendBody />);
		for (const k of MARK_ORDER) expect(html).toContain(MARK_LOOK[k].name);
	});

	test("the legend button is closed until asked, and is a labelled control", () => {
		const html = renderToStaticMarkup(<FlowLegend />);
		expect(html).toContain('aria-label="Legend"');
		expect(html).toContain('aria-expanded="false"');
		expect(html).not.toContain("data-legend-popover");
	});

	test("every mark has its own shape, and no two share shape and colour", () => {
		const shapes = MARK_ORDER.map((k) => MARK_LOOK[k].shape);
		expect(new Set(shapes).size).toBe(shapes.length);
		const looks = MARK_ORDER.map(
			(k) => `${MARK_LOOK[k].shape}/${MARK_LOOK[k].token}`,
		);
		expect(new Set(looks).size).toBe(looks.length);
	});
});

describe("bars and markers", () => {
	const scale = makeScale(NOW - 2 * HOUR, NOW, 720);

	test("activity bars take the activity's token; a question is warn", () => {
		const { bars } = cellModel({
			scale,
			now: NOW,
			spans: [
				span("run:r1", "activity", "working", 60 * MIN, 30 * MIN),
				span("run:r1", "activity", "needs_answer", 30 * MIN, null, {
					question: "Reject or migrate?",
				}),
			],
		});
		expect(bars.map((b) => b.token)).toEqual([
			"--mfw-status-in-progress",
			"--mfw-warn",
		]);
		const [first, open] = bars;
		expect(first?.x).toBe(scale.x(NOW - 60 * MIN));
		// the open span runs to now (the right edge)
		expect((open?.x ?? 0) + (open?.width ?? 0)).toBe(720);
		expect(open?.tip.text).toContain("Reject or migrate?");
	});

	test("a task's long-lived status is a 2px rail, not a bar in the activity lane", () => {
		const m = cellModel({
			scale,
			now: NOW,
			spans: [span("task:A", "status", "in_progress", 90 * MIN, null)],
		});
		expect(m.bars).toHaveLength(0);
		expect(m.rail).toHaveLength(1);
		expect(m.rail[0]?.height).toBe(2);
	});

	test("a run with no spans or events is an empty, quiet cell", () => {
		const m = cellModel({ scale, now: NOW, spans: [], markers: [] });
		expect(m).toEqual({ bars: [], rail: [], marks: [], clusters: [] });
		const html = renderToStaticMarkup(
			<TimelineCell scale={scale} now={NOW} spans={[]} markers={[]} />,
		);
		expect(html).not.toContain("<rect");
		expect(html).not.toContain("data-marker");
	});

	test("a finished run ends in its outcome mark, in the marker lane", () => {
		const m = cellModel({
			scale,
			now: NOW,
			spans: [span("run:r1", "state", "failed", 20 * MIN, 20 * MIN)],
		});
		expect(m.bars).toHaveLength(0);
		expect(m.marks).toHaveLength(1);
		expect(m.marks[0]).toMatchObject({ kind: "failed", subject: "run:r1" });
	});

	test("an ended hold leaves a released mark and a faint wait bar", () => {
		const m = cellModel({
			scale,
			now: NOW,
			spans: [
				span("task:A", "hold", "resource", 60 * MIN, 30 * MIN),
				span("run:r1", "state", "completed", 10 * MIN, 10 * MIN),
			],
		});
		expect(m.marks.map((x) => x.kind).sort()).toEqual(["passed", "released"]);
		expect(m.bars).toHaveLength(1);
		expect(m.bars[0]?.opacity).toBeLessThan(0.5);
	});

	test("markers sit at their time, carry the node they point at, and leave with the window", () => {
		const { marks } = cellModel({
			scale,
			now: NOW,
			spans: [],
			markers: [
				marker("run:r1", "decision", 30 * MIN, "decision:512"),
				marker("run:r1", "merge", 10 * MIN, "merge:4"),
				marker("run:r1", "verdict", 5 * HOUR, "run:rev"),
			],
		});
		expect(marks.map((m) => m.ref)).toEqual(["decision:512", "merge:4"]);
		expect(marks[0]).toMatchObject({ kind: "decision", subject: "run:r1" });
		expect(marks[1]).toMatchObject({ kind: "merge" });
	});

	test("events closer than the icon pitch become one counted cluster, and zooming splits it", () => {
		const events = [
			marker("run:r1", "decision", 30 * MIN, "decision:1"),
			marker("run:r1", "human", 30 * MIN - 5_000, "decision:2"),
			marker("run:r1", "decision", 30 * MIN - 9_000, "decision:3"),
		];
		const out = cellModel({ scale, now: NOW, spans: [], markers: events });
		expect(out.clusters).toHaveLength(1);
		expect(out.clusters[0]?.members).toHaveLength(3);
		const html = renderToStaticMarkup(
			<TimelineCell scale={scale} now={NOW} spans={[]} markers={events} />,
		);
		expect(html).toContain('data-cluster="3"');
		expect(html).not.toContain("data-marker=");
		// the same three events across a 2 minute window are well apart
		const zoomed = makeScale(NOW - 31 * MIN, NOW - 29 * MIN, 720);
		const split = cellModel({
			scale: zoomed,
			now: NOW,
			spans: [],
			markers: events,
		});
		expect(split.clusters).toHaveLength(3);
	});

	test("collapsed rows show the activity of what is below them, not state or markers", () => {
		const { bars, marks } = cellModel({
			scale,
			now: NOW,
			spans: [],
			rolled: [
				span("run:x", "activity", "working", HOUR, 30 * MIN),
				span("run:x", "state", "running", HOUR, 30 * MIN),
			],
		});
		expect(bars).toHaveLength(1);
		expect(bars[0]?.height).toBeLessThan(8);
		expect(marks).toHaveLength(0);
	});

	test("brain turns are a compact strip; a failed turn is red", () => {
		const { bars } = cellModel({
			scale,
			now: NOW,
			spans: [
				span("brain", "turn", "ok", 50 * MIN, 49 * MIN),
				span("brain", "turn", "failed", 30 * MIN, 29 * MIN),
			],
		});
		expect(bars.map((b) => b.token)).toEqual([
			"--mfw-accent",
			"--mfw-critical",
		]);
		for (const b of bars) expect(b.height).toBeLessThanOrEqual(8);
	});

	test("clicking a marker selects the node it points at", () => {
		const picked: [string, string][] = [];
		const { marks } = cellModel({
			scale,
			now: NOW,
			spans: [],
			markers: [marker("run:r1", "decision", 30 * MIN, "decision:512")],
		});
		const drawn = MarkButton({
			mark: marks[0] as (typeof marks)[number],
			x: 10,
			tabIndex: 0,
			onMarker: (ref, subject) => picked.push([ref, subject]),
		});
		(drawn.props.onClick as (e: { stopPropagation(): void }) => void)({
			stopPropagation() {},
		});
		expect(picked).toEqual([["decision:512", "run:r1"]]);
	});

	test("markers are real, named, focusable buttons; bars stay out of the a11y tree", () => {
		const html = renderToStaticMarkup(
			<TimelineCell
				scale={scale}
				now={NOW}
				spans={[span("run:r1", "activity", "working", HOUR, null)]}
				markers={[marker("run:r1", "decision", 30 * MIN, "decision:1")]}
				label="Events on r1"
			/>,
		);
		expect(html).toContain('aria-label="Events on r1"');
		expect(html).toMatch(
			/<button[^>]*data-marker="decision"[^>]*aria-label="brain decision: decision label/,
		);
		expect(html).toContain('tabindex="0"');
		const svg = /<svg[^>]*data-timeline-cell[^>]*>/.exec(html)?.[0] ?? "";
		expect(svg).toContain('aria-hidden="true"');
	});

	test("the sparkline has no markers", () => {
		const html = renderToStaticMarkup(
			<TimelineCell
				scale={makeScale(NOW - 2 * HOUR, NOW, 40)}
				now={NOW}
				spans={[span("run:r1", "activity", "working", HOUR, null)]}
				markers={[marker("run:r1", "decision", 30 * MIN, "decision:1")]}
				compact
			/>,
		);
		expect(html).toContain("<rect");
		expect(html).not.toContain("data-marker");
	});
});

describe("window controls", () => {
	function findButtons(tree: unknown) {
		const out: ReactElement<Record<string, unknown>>[] = [];
		const walk = (n: unknown) => {
			if (Array.isArray(n)) n.forEach(walk);
			else if (isValidElement<Record<string, unknown>>(n)) {
				if (n.type === "button" || n.type === TipButton) out.push(n);
				walk(n.props.children);
			}
		};
		walk(tree);
		return out;
	}

	test("LIVE is pressed while following, and pressing it asks for live", () => {
		let liveCalls = 0;
		const tree = TimeControls({
			windowId: "2h",
			live: true,
			onWindow: () => {},
			onPan: () => {},
			onLive: () => liveCalls++,
		});
		const live = findButtons(tree).find((b) => b.props.tip === "Following now");
		expect(live?.props["aria-pressed"]).toBe(true);
		(live?.props.onClick as () => void)();
		expect(liveCalls).toBe(1);
	});

	test("presets mark the current window and report the one chosen", () => {
		const chosen: string[] = [];
		const tree = TimeControls({
			windowId: "8h",
			live: false,
			onWindow: (w) => chosen.push(w),
			onPan: () => {},
			onLive: () => {},
		});
		const buttons = findButtons(tree);
		const pressed = buttons.filter((b) => b.props["aria-pressed"] === true);
		expect(pressed).toHaveLength(1);
		expect(pressed[0]?.props.children).toBe("8h");
		const h1 = buttons.find((b) => b.props.children === "1h");
		(h1?.props.onClick as () => void)();
		expect(chosen).toEqual(["1h"]);
	});
});

describe("shared row", () => {
	test("in a list (Home) a row is a listitem with no tree levels, and links its title", () => {
		const view = buildFlow([task("A"), run("r1", "task:A")], {
			overrides: new Map([["task:A", true]]),
		});
		const html = renderToStaticMarkup(
			<div>
				{view.rows.map((r) => (
					<NodeRow
						key={r.key}
						row={r}
						now={NOW}
						mode="list"
						to={`/p/mfw/flow?node=${r.key}`}
					/>
				))}
			</div>,
		);
		expect(html).toContain('role="listitem"');
		expect(html).not.toContain("aria-level");
		expect(html).toContain('href="/p/mfw/flow?node=run:r1"');
	});

	test("the same run draws the same markup in the grid and in a list apart from the tree attributes", () => {
		const view = buildFlow([task("A"), run("r1", "task:A")], {
			overrides: new Map([["task:A", true]]),
		});
		const row = view.rows.find((r) => r.key === "run:r1") as FlowRow;
		const grid = renderToStaticMarkup(
			<NodeRow row={row} now={NOW} mode="grid" />,
		);
		const list = renderToStaticMarkup(
			<NodeRow row={row} now={NOW} mode="list" />,
		);
		const cell = (html: string) =>
			html.slice(html.indexOf('<div class="flex min-w-0 flex-1'));
		expect(cell(grid.replace(' role="gridcell"', ""))).toBe(cell(list));
	});
});

describe("attempt groups", () => {
	const group = (
		over: Partial<NonNullable<FlowNodeIn["group"]>> = {},
	): FlowNodeIn =>
		({
			ref: "group:G1",
			parent: "task:A",
			kind: "group",
			title: "2 competing attempts",
			needsMe: null,
			lastAt: new Date(NOW),
			rollup: { total: 2, done: 1, live: 1, needsMe: 0, costUsdToday: 0 },
			group: {
				kind: "competing",
				selection: "brain",
				status: "open",
				winner: null,
				createdBy: "decision:7",
				attempts: 2,
				closedAt: null,
				...over,
			},
		}) as FlowNodeIn;
	const attempt = (id: string, winner: boolean): FlowNodeIn => {
		const r = run(id, "group:G1", { state: "completed", activity: null });
		return {
			...r,
			run: {
				...(r.run as NonNullable<FlowNodeIn["run"]>),
				attempt: { groupRef: "group:G1", role: "attempt", winner },
			},
		} as FlowNodeIn;
	};

	test("a competing group draws the compete mark, its status and who selects; the attempts nest under it", () => {
		const view = buildFlow([
			task("A"),
			group(),
			run("r1", "group:G1"),
			run("r2", "group:G1"),
		]);
		const g = view.rows.find((r) => r.key === "group:G1") as FlowRow;
		expect(g.expandable).toBe(true);
		const html = renderToStaticMarkup(
			<NodeRow row={g} now={NOW} mode="grid" />,
		);
		expect(html).toContain('data-glyph="compete"');
		expect(html).toContain("2 competing attempts");
		expect(html).toContain("open");
		expect(html).toContain("brain");
		expect(html).not.toContain("group-winner");
		expect(rowAccessibleName(g, NOW)).toBe(
			"Competing group, 2 competing attempts, open",
		);
		const depths = view.rows.map((r) => [r.key, r.depth]);
		expect(depths).toContainEqual(["run:r1", 2]);
	});

	test("the winner is starred on the group row and on its attempt", () => {
		const view = buildFlow(
			[
				task("A"),
				group({ status: "selecting", winner: "run:r1" }),
				attempt("r1", true),
				attempt("r2", false),
			],
			{
				overrides: new Map([
					["task:A", true],
					["group:G1", true],
				]),
			},
		);
		const g = view.rows.find((r) => r.key === "group:G1") as FlowRow;
		const html = renderToStaticMarkup(
			<NodeRow row={g} now={NOW} mode="grid" />,
		);
		expect(html).toContain("group-winner");
		expect(html).toContain("winner chosen");
		expect(rowAccessibleName(g, NOW)).toContain("winner r1");
		const winner = view.rows.find((r) => r.key === "run:r1") as FlowRow;
		const loser = view.rows.find((r) => r.key === "run:r2") as FlowRow;
		expect(
			renderToStaticMarkup(<NodeRow row={winner} now={NOW} mode="grid" />),
		).toContain("run-winner");
		expect(
			renderToStaticMarkup(<NodeRow row={loser} now={NOW} mode="grid" />),
		).not.toContain("run-winner");
	});

	test("the folded earlier-runs group still draws as before", () => {
		const folded = {
			ref: "group:ended:A",
			parent: "task:A",
			kind: "group",
			title: "5 earlier runs",
			needsMe: null,
			lastAt: new Date(NOW),
		} as FlowNodeIn;
		const view = buildFlow([task("A"), folded], {
			overrides: new Map([["task:A", true]]),
		});
		const row = view.rows.find((r) => r.key === "group:ended:A") as FlowRow;
		const html = renderToStaticMarkup(
			<NodeRow row={row} now={NOW} mode="grid" />,
		);
		expect(html).toContain("5 earlier runs");
		expect(html).not.toContain('data-glyph="compete"');
	});
});

describe("grid keyboard wiring", () => {
	const rows = buildFlow(NODES, {
		overrides: new Map([["task:E", true]]),
	}).rows;
	const key = (
		k: string,
		over: Partial<Parameters<typeof keyboardStep>[0]> = {},
	) =>
		keyboardStep(
			{
				key: k,
				metaKey: false,
				ctrlKey: false,
				altKey: false,
				fromControl: false,
				...over,
			},
			rows,
			0,
		);

	test("j k h l Enter . and the arrows move or act", () => {
		expect(key("j")?.focus).toBe(1);
		expect(key("ArrowDown")?.focus).toBe(1);
		expect(key("l")?.focus).toBe(1); // already open: steps in
		expect(key("h")?.toggle).toEqual({ key: "task:E", open: false });
		expect(key("Enter")?.select).toBe("task:E");
		expect(key(".")?.actions).toBe("task:E");
	});

	test("chords and keys of a control inside a row are left alone", () => {
		expect(key("j", { metaKey: true })).toBeNull();
		expect(key("k", { ctrlKey: true })).toBeNull();
		expect(key("Enter", { fromControl: true })).toBeNull();
		expect(key("x")).toBeNull();
	});

	test("row ids are DOM-safe and distinct per key", () => {
		expect(rowDomId("run:01J/ABC")).toBe("flow-row-run_01J_ABC");
		expect(rowDomId("fold:task:E")).not.toBe(rowDomId("task:E"));
	});

	test("the grid names its active row for assistive tech", () => {
		const html = renderToStaticMarkup(
			<TreeGrid
				rows={rows}
				label="Work tree"
				selectedKey="task:A"
				renderRow={(row, ctx) => <NodeRow row={row} now={NOW} id={ctx.id} />}
				onToggle={() => {}}
				onSelect={() => {}}
			/>,
		);
		expect(html).toContain(`aria-activedescendant="${rowDomId("task:A")}"`);
		expect(html).toContain(`id="${rowDomId("task:A")}"`);
	});
});

describe("the brain at the root of the tree", () => {
	const brain = (state: "idle" | "turn" | "failed" = "idle"): FlowNodeIn =>
		({
			ref: "brain",
			parent: null,
			kind: "brain",
			title: "Brain · gen 3",
			needsMe: state === "failed" ? "brain_stuck" : null,
			lastAt: new Date(NOW),
			brain: {
				sessionId: "S",
				state,
				generation: 3,
				harness: "claude-cli",
				model: "opus",
				effort: null,
				turnsLast24h: 41,
				liveTurnRunId: null,
				consecutiveFailures: 0,
				lastTurnAt: null,
			},
		}) as FlowNodeIn;
	const tree = (state?: "idle" | "turn" | "failed") => [
		brain(state),
		task("A", { parent: "brain", status: { value: "ready", role: "ready" } }),
	];

	test("it is the single root and starts open, tasks one level under it", () => {
		const view = buildFlow(tree());
		expect(view.rows.map((r) => [r.key, r.depth])).toEqual([
			["brain", 0],
			["task:A", 1],
		]);
		expect(view.rows[0]?.expanded).toBe(true);
	});

	test("its row draws the glyph, the turns and a loud name when stuck", () => {
		const nodes = tree("failed");
		const view = buildFlow(nodes);
		const html = renderToStaticMarkup(lens({ nodes }));
		expect(html).toContain("41 turns/24h");
		expect(html).toContain("brain stuck");
		expect(html).toContain('data-glyph="stuck"');
		expect(rowAccessibleName(view.rows[0] as FlowRow, NOW)).toBe(
			"Brain, generation 3, stuck, needs you",
		);
	});

	test("turns are bars on its row and a decision asking for a person is a loud marker", () => {
		const scale = makeScale(NOW - 2 * HOUR, NOW, 720);
		const { bars, marks } = cellModel({
			scale,
			now: NOW,
			spans: [
				span("brain", "turn", "ok", 50 * MIN, 49 * MIN),
				span("brain", "turn", "failed", 30 * MIN, 29 * MIN),
				span("brain", "turn", "running", 2 * MIN, null),
			],
			markers: [marker("brain", "notify", 20 * MIN, "decision:9")],
		});
		const tokens = bars.map((b) => b.token);
		expect(tokens).toContain("--mfw-accent");
		expect(tokens).toContain("--mfw-critical");
		expect(tokens).toContain("--mfw-status-in-progress");
		expect(marks[0]).toMatchObject({
			kind: "notify",
			ref: "decision:9",
			subject: "brain",
		});
		expect(marks[0]?.label).toContain("needs you");
	});

	test("the legend names the escalation marker", () => {
		expect(legendEntries().map((e) => e.label)).toContain("needs you");
	});
});

describe("markers are SVG shapes, not text glyphs", () => {
	test("each marker kind draws one 16px icon, spaced so none overlap, and no text glyph", () => {
		const scale = makeScale(NOW - 2 * HOUR, NOW, 720);
		const kinds = [
			"decision",
			"human",
			"merge",
			"hold",
			"verify_fail",
			"verdict",
			"notify",
			"spawn",
		] as const;
		const html = renderToStaticMarkup(
			<TimelineCell
				scale={scale}
				now={NOW}
				spans={[]}
				markers={kinds.map((k, i) =>
					marker("run:r1", k, (i + 1) * 10 * MIN, `x:${i}`),
				)}
			/>,
		);
		expect(html).not.toContain("<text");
		expect(html.match(/data-marker="/g)?.length).toBe(kinds.length);
		expect(html).toContain("human action");
		expect(html).toContain('width="16" height="16"');
		const shapes = html.match(/data-mark-shape="[^"]+"/g) ?? [];
		expect(new Set(shapes).size).toBe(kinds.length);
	});
});
