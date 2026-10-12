import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowNode, FlowSpan } from "@mfw/daemon/flow";
import { renderToStaticMarkup } from "react-dom/server";

// Vite provides BASE_URL (AppLink reads it); bun test does not.
process.env.BASE_URL ??= "/";

import {
	bandSegments,
	fractionOf,
	nearestIndexByTs,
	tsAtFraction,
} from "./bandModel";
import {
	LineageHeader,
	originLabel,
	PrunedBody,
	prunedSummary,
} from "./RunInspector";
import { StateBand } from "./StateBand";

const T = Date.UTC(2026, 9, 12, 12, 0, 0);
const MIN = 60_000;

const span = (
	lane: string,
	value: string,
	startMin: number,
	endMin: number | null,
	detail?: Record<string, unknown>,
): FlowSpan => ({
	subject: "run:r2",
	lane,
	value,
	start: new Date(T + startMin * MIN),
	end: endMin === null ? null : new Date(T + endMin * MIN),
	...(detail ? { detail } : {}),
});

describe("the band's maths", () => {
	test("a fraction maps to an instant and back, clamped to the run", () => {
		expect(tsAtFraction(T, T + 10 * MIN, 0.5)).toBe(T + 5 * MIN);
		expect(tsAtFraction(T, T + 10 * MIN, -1)).toBe(T);
		expect(tsAtFraction(T, T + 10 * MIN, 7)).toBe(T + 10 * MIN);
		expect(tsAtFraction(T, T + 10 * MIN, Number.NaN)).toBe(T);
		expect(fractionOf(T, T + 10 * MIN, T + 2 * MIN)).toBeCloseTo(0.2, 10);
		expect(fractionOf(T, T, T + MIN)).toBe(0);
	});

	test("dragging lands on the entry nearest that instant", () => {
		const stamps = [0, 10, 20, 40, 100].map((m) => T + m * MIN);
		expect(nearestIndexByTs(stamps, T + 12 * MIN)).toBe(1);
		expect(nearestIndexByTs(stamps, T + 18 * MIN)).toBe(2);
		expect(nearestIndexByTs(stamps, T + 29 * MIN)).toBe(2);
		expect(nearestIndexByTs(stamps, T + 31 * MIN)).toBe(3);
		// before the first, after the last
		expect(nearestIndexByTs(stamps, T - 5 * MIN)).toBe(0);
		expect(nearestIndexByTs(stamps, T + 500 * MIN)).toBe(4);
		// an exact hit, and a tie going to the earlier entry
		expect(nearestIndexByTs(stamps, T + 20 * MIN)).toBe(2);
		expect(nearestIndexByTs(stamps, T + 30 * MIN)).toBe(2);
		expect(nearestIndexByTs([], T)).toBe(-1);
	});

	test("segments carry the activity token and the question; queued time fills in where no activity covers", () => {
		const segs = bandSegments(
			[
				span("state", "starting", 0, 2),
				span("activity", "working", 2, 6),
				span("activity", "needs_answer", 6, null, { question: "Which?" }),
				span("state", "running", 2, null),
			],
			T,
			T + 10 * MIN,
			T + 10 * MIN,
		);
		expect(segs.map((s) => [s.label, s.token, s.lane])).toEqual([
			["queued", "--mfw-neutral", "state"],
			["working", "--mfw-status-in-progress", "activity"],
			["needs answer", "--mfw-warn", "activity"],
		]);
		expect(segs[1]).toMatchObject({ left: 20, width: 40 });
		// the open span runs to the end of the band
		expect(segs[2]?.left).toBe(60);
		expect(segs[2]?.width).toBe(40);
		expect(segs[2]?.question).toBe("Which?");
	});

	test("spans outside the run are clipped away", () => {
		expect(
			bandSegments(
				[span("activity", "working", -30, -10)],
				T,
				T + 10 * MIN,
				T + 10 * MIN,
			),
		).toEqual([]);
		expect(bandSegments([], T, T, T)).toEqual([]);
	});
});

describe("StateBand", () => {
	test("is a slider over the run's time with its segments drawn", () => {
		const html = renderToStaticMarkup(
			<StateBand
				spans={[span("activity", "working", 0, 5)]}
				start={T}
				end={T + 10 * MIN}
				now={T + 10 * MIN}
				cursor={T + 5 * MIN}
				onScrub={() => {}}
			/>,
		);
		expect(html).toContain('role="slider"');
		expect(html).toContain(`aria-valuemin="${T}"`);
		expect(html).toContain(`aria-valuemax="${T + 10 * MIN}"`);
		expect(html).toContain(`aria-valuenow="${T + 5 * MIN}"`);
		expect(html).toContain('data-segment="working"');
		expect(html).toContain("var(--mfw-status-in-progress)");
		// the cursor sits halfway
		expect(html).toContain("left:50%");
	});
});

describe("lineage header", () => {
	const mk = (
		id: string,
		relation: string,
		state: string,
		activity: string | null,
		at: number,
		parent: string,
	): FlowNode =>
		({
			ref: `run:${id}`,
			parent,
			kind: "run",
			title: `${id} title`,
			needsMe: null,
			lastAt: new Date(T + at),
			run: {
				role: "worker",
				relation,
				state,
				activity,
				harness: "claude-cli",
				model: "sonnet",
				effort: null,
				host: null,
				label: id,
				startedAt: new Date(T + at),
				finishedAt: null,
				costUsd: null,
				liveCostUsd: null,
			},
		}) as FlowNode;
	const family = [
		mk("r1", "fresh", "failed", null, 0, "task:A"),
		mk("r2", "repair", "running", "needs_answer", 1, "run:r1"),
		mk("r3", "resume", "starting", null, 2, "run:r2"),
	];
	const props = {
		project: "mfw",
		runRef: "run:r2",
		label: "r2",
		crumbs: [
			{ ref: "task:E", label: "E Epic" },
			{ ref: "task:A", label: "A Parse config" },
			{ ref: "run:r1", label: "r1" },
		],
		family,
		continues: family[0] as FlowNode,
		spawnedByDecisionId: 512,
		originRef: null,
	};

	test("the breadcrumb is the tree's parents, root first, ending at this run", () => {
		const html = renderToStaticMarkup(<LineageHeader {...props} />);
		const order = ["E Epic", "A Parse config", ">r1<", ">r2<"].map((s) =>
			html.indexOf(s),
		);
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(html).toContain('aria-current="page"');
		expect(html).toContain('href="/p/mfw/n/task:A"');
	});

	test("the sibling switcher lists the whole chain and marks this run", () => {
		const html = renderToStaticMarkup(<LineageHeader {...props} />);
		expect(html).toContain('aria-label="Runs in this chain"');
		for (const n of ["#1", "#2", "#3"]) expect(html).toContain(n);
		// the others are links to their own inspector; this one is not
		expect(html).toContain('href="/p/mfw/n/run:r1"');
		expect(html).toContain('href="/p/mfw/n/run:r3"');
		expect(html).not.toContain('href="/p/mfw/n/run:r2"');
		expect(html.match(/aria-current="true"/g)).toHaveLength(1);
		// glyph and word, not colour alone
		expect(html).toContain("needs answer");
		expect(html).toContain("failed");
	});

	test("says what spawned it and which run it continues", () => {
		const html = renderToStaticMarkup(<LineageHeader {...props} />);
		expect(html).toContain("spawned by brain decision 512");
		expect(html).toContain('href="/p/mfw/n/decision:512"');
		expect(html).toContain("continues");
		expect(html).toContain("#1 r1 title");
	});

	test("inside a lens the links select the node there instead of leaving it", () => {
		const html = renderToStaticMarkup(
			<LineageHeader {...props} onSelectNode={() => {}} />,
		);
		expect(html).not.toContain('href="/p/mfw/n/');
		expect(html).toContain("<button");
	});

	test("a lone run with no spawn shows no switcher", () => {
		const html = renderToStaticMarkup(
			<LineageHeader
				{...props}
				family={[]}
				continues={null}
				spawnedByDecisionId={null}
			/>,
		);
		expect(html).not.toContain("Runs in this chain");
		expect(html).not.toContain("spawned by");
	});

	test("origins outside the tree read in words", () => {
		expect(originLabel("session:01JABCDEFGH")).toBe("escalation ABCDEFGH");
		expect(originLabel("human:kikijiki")).toBe("you (kikijiki)");
		expect(originLabel(null)).toBeNull();
		const html = renderToStaticMarkup(
			<LineageHeader
				{...props}
				family={[]}
				continues={null}
				spawnedByDecisionId={null}
				originRef="human:kikijiki"
			/>,
		);
		expect(html).toContain("from you (kikijiki)");
	});
});

describe("pruned transcript", () => {
	test("a run with a stored summary is pruned; one without is not", () => {
		expect(prunedSummary(null)).toBeNull();
		expect(prunedSummary(undefined)).toBeNull();
		expect(prunedSummary({ events: 3 })).toEqual({ events: 3 });
	});

	test("renders the summary and the kept steps, and says why there is no transcript", () => {
		const html = renderToStaticMarkup(
			<PrunedBody
				summary={{
					lastAssistant: "Done: parser now handles v1 keys.",
					toolCalls: { Edit: 4, Bash: 9 },
					filesTouched: ["src/config/parse.ts"],
					firstError: "TS2322 in parse.ts",
					events: 212,
					prunedAt: T,
				}}
				steps={[{ step: "verify", status: "failed", error: "typecheck" }]}
				state="failed"
				model="sonnet"
			/>,
		);
		expect(html).toContain("Transcript pruned");
		expect(html).toContain("summary, steps, verdicts and diff stat kept");
		expect(html).toContain("Done: parser now handles v1 keys.");
		expect(html).toContain("Bash ×9 · Edit ×4");
		expect(html).toContain("src/config/parse.ts");
		expect(html).toContain("TS2322 in parse.ts");
		expect(html).toContain("verify: failed (typecheck)");
	});
});

describe("the inspector's run body", () => {
	test("is the run inspector (lineage, band, transcript), not the bare transcript page", () => {
		const source = readFileSync(join(import.meta.dir, "Inspector.tsx"), "utf8");
		expect(source).toContain("<RunInspector");
		expect(source).not.toContain("<RunPage");
		// and the transcript page takes the band's cursor
		const page = readFileSync(
			join(import.meta.dir, "..", "transcript", "RunPage.tsx"),
			"utf8",
		);
		expect(page).toContain("scrollToTs");
		expect(page).toContain("nearestIndexByTs");
	});
});
