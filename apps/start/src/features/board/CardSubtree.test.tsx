import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppRouter } from "@mfw/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { renderToString as renderRaw } from "react-dom/server";
import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import type { StoryEntry, StoryRunEntry } from "../inspector/story";
import { TaskCard } from "./BoardPage";
import { BoardAgentsContext, boardAgents } from "./boardAgents";
import {
	CardSubtree,
	flattenRuns,
	isCardToggleKey,
	lastSettled,
	outcomeTail,
	pendingIntent,
	SUBTREE_LIMIT,
} from "./CardSubtree";

process.env.BASE_URL ??= "/";

/** React separates adjacent text nodes with comments; the assertions read the text. */
const renderToString = (el: Parameters<typeof renderRaw>[0]) =>
	renderRaw(el).replaceAll("<!-- -->", "");

const PROJECT = "alpha";
const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m);

function run(
	id: string,
	over: Partial<StoryRunEntry["summary"]> = {},
	extra: Partial<StoryRunEntry> = {},
): StoryRunEntry {
	return {
		kind: "run",
		at: at(10),
		ref: `run:${id}`,
		summary: {
			role: "task",
			relation: "fresh",
			state: "completed",
			activity: null,
			harness: "claude-cli",
			model: "claude-opus-4-7",
			effort: null,
			host: null,
			label: `T-1#${id}`,
			attempt: 1,
			startedAt: at(10),
			finishedAt: at(11),
			costUsd: 0.84,
			...over,
		},
		states: [],
		verify: [],
		verdicts: [],
		transcriptAvailable: true,
		children: [],
		...extra,
	} as StoryRunEntry;
}

function decision(hour: number): StoryEntry {
	return {
		kind: "decision",
		at: at(hour),
		id: 1,
		role: "brain",
		tool: "spawn_attempts",
		target: "task:T-1",
		subjectRunId: null,
		rationale: "verify flaked twice",
		outcome: "applied",
		effects: [],
	};
}

function harness() {
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

function seedStory(h: ReturnType<typeof harness>, entries: StoryEntry[]) {
	h.queryClient.setQueryData(
		h.trpc.node.story.queryKey({
			project: PROJECT,
			ref: "task:T-1",
			limit: SUBTREE_LIMIT,
			filter: { kinds: ["run", "group", "decision"] },
		}),
		{ entries, cursor: null },
	);
}

function wrap(h: ReturnType<typeof harness>, child: React.ReactNode) {
	return (
		<ToastProvider>
			<QueryClientProvider client={h.queryClient}>
				<TRPCProvider trpcClient={h.client} queryClient={h.queryClient}>
					{child}
				</TRPCProvider>
			</QueryClientProvider>
		</ToastProvider>
	);
}

const LIVE = {
	project: PROJECT,
	runId: "RL",
	kind: "task",
	state: "running",
	taskId: "T-1",
	providerId: "claude-cli",
	model: "claude-opus-4-7",
	startedAt: Date.now() - 60_000,
	activity: "working",
	activityDetail: null,
	scopeSample: null,
	capabilities: {
		verified: true,
		steer: true,
		interrupt: true,
		approvals: true,
	},
};

describe("expanded card subtree", () => {
	test("runs nest by lineage and live ones carry steer and stop", () => {
		const h = harness();
		seedStory(h, [
			run(
				"R1",
				{ state: "failed" },
				{
					children: [
						run(
							"R2",
							{
								relation: "repair",
								state: "running",
								activity: "working",
								finishedAt: null,
								label: "T-1#repair",
							},
							{ lastLine: "Edit src/parse.ts" },
						),
					],
				},
			),
		]);
		h.queryClient.setQueryData(h.trpc.runs.active.queryKey(), [
			{ ...LIVE, runId: "R2" },
		] as never);
		const html = renderToString(
			wrap(h, <CardSubtree project={PROJECT} taskId="T-1" />),
		);
		expect(html).toContain('data-run="R1"');
		expect(html).toContain('data-run="R2"');
		// R2 is rendered inside R1's list, one level deeper.
		expect(html).toContain('data-depth="1"');
		expect(html.indexOf('data-run="R1"')).toBeLessThan(
			html.indexOf('data-run="R2"'),
		);
		expect(html).toContain("last: Edit src/parse.ts");
		expect(html).toContain('aria-label="Steer T-1#repair"');
		expect(html).toContain(">Stop<");
		// Only the live run is controllable.
		expect(html.match(/>Stop</g)).toHaveLength(1);
		expect(h.calls).toEqual([]);
	});

	test("the attempts of a competing group are on the card, live ones controllable", () => {
		const h = harness();
		const group: StoryEntry = {
			kind: "group",
			at: at(9),
			ref: "group:G1",
			group: {
				kind: "competing",
				selection: "brain",
				status: "open",
				winnerRunId: null,
				createdBy: "decision:3",
				closedAt: null,
			},
			attempts: [
				run("A1", { state: "failed" }),
				run("A2", { state: "running", activity: "working", finishedAt: null }),
			],
		};
		seedStory(h, [group]);
		h.queryClient.setQueryData(h.trpc.runs.active.queryKey(), [
			{ ...LIVE, runId: "A2" },
		] as never);
		const html = renderToString(
			wrap(h, <CardSubtree project={PROJECT} taskId="T-1" />),
		);
		expect(html).toContain('data-run="A1"');
		expect(html).toContain('data-run="A2"');
		expect(html).not.toContain("No runs yet");
		expect(html.match(/>Stop</g)).toHaveLength(1);
		// and the card's outcome line reads the settled attempt
		expect(lastSettled([group])).toMatchObject({ state: "failed" });
	});

	test("steer is not offered when the harness cannot steer", () => {
		const h = harness();
		seedStory(h, [
			run("R2", { state: "running", activity: "working", finishedAt: null }),
		]);
		h.queryClient.setQueryData(h.trpc.runs.active.queryKey(), [
			{ ...LIVE, runId: "R2", capabilities: { verified: true, steer: false } },
		] as never);
		const html = renderToString(
			wrap(h, <CardSubtree project={PROJECT} taskId="T-1" />),
		);
		expect(html).not.toContain("Steer T-1");
		expect(html).toContain(">Stop<");
	});

	test("never opens a transcript stream: no console, no tail, no run-output subscription", () => {
		const src = readFileSync(join(import.meta.dir, "CardSubtree.tsx"), "utf8");
		expect(src).not.toMatch(/RunConsole|TranscriptTail|runOutput/);
	});

	test("an expanded TaskCard draws the subtree; a compact one does not", () => {
		const h = harness();
		seedStory(h, [run("R1")]);
		const t = {
			id: "T-1",
			title: "Task T-1",
			type: "implementation",
			priority: "medium",
			size: null,
			labels: [],
			dependsOn: [],
			status: "done",
			statusChangedAt: new Date(0),
			blockedReason: null,
			verification: null,
			draftPhase: null,
			draftAttempts: 0,
			afterExpansion: "ready",
			claimedByRunId: null,
			claimedAt: null,
		};
		const agents = boardAgents(PROJECT, [], [], {
			"T-1": [{ ref: "run:R1", glyph: "ok" }],
		});
		const card = (expanded: boolean) =>
			renderToString(
				wrap(
					h,
					<BoardAgentsContext.Provider value={agents}>
						<TaskCard
							task={t as never}
							project={PROJECT}
							draggable
							defaultExpanded={expanded}
						/>
					</BoardAgentsContext.Provider>,
				),
			);
		const open = card(true);
		expect(open).toContain('data-testid="card-subtree"');
		expect(open).toContain('aria-expanded="true"');
		expect(open).toContain('aria-label="Collapse T-1"');
		const closed = card(false);
		expect(closed).not.toContain('data-testid="card-subtree"');
		expect(closed).toContain('aria-label="Expand T-1"');
		// Cards are focusable so Space can reach them.
		expect(closed).toContain('tabindex="0"');
	});

	test("a collapsed card shows the brain's intent, and no intent means no line", () => {
		const h = harness();
		seedStory(h, [run("R1")]);
		const t = {
			id: "T-1",
			title: "Task T-1",
			type: "implementation",
			priority: "medium",
			size: null,
			labels: [],
			dependsOn: [],
			status: "ready",
			statusChangedAt: new Date(0),
			blockedReason: null,
			verification: null,
			draftPhase: null,
			draftAttempts: 0,
			afterExpansion: "ready",
			claimedByRunId: null,
			claimedAt: null,
		};
		const withIntent = boardAgents(PROJECT, [], [], {}, [
			{
				taskId: "T-1",
				decisionId: 7,
				tool: "retry_on_codex",
				rationale: "verify flaked twice",
				confidence: "medium",
				state: "proposed",
			},
		]);
		const card = (ctx: typeof withIntent) =>
			renderToString(
				wrap(
					h,
					<BoardAgentsContext.Provider value={ctx}>
						<TaskCard task={t as never} project={PROJECT} draggable />
					</BoardAgentsContext.Provider>,
				),
			);
		const closed = card(withIntent);
		expect(closed).toContain('data-testid="brain-intent"');
		expect(closed).toContain("retry on codex");
		expect(closed).toContain("verify flaked twice");
		expect(closed).toContain("(proposed)");
		expect(card(boardAgents(PROJECT, [], []))).not.toContain("brain-intent");
	});
});

describe("Space toggles the card", () => {
	const card = {};
	test("Space on the card itself toggles", () => {
		expect(
			isCardToggleKey({ key: " ", target: card, currentTarget: card }),
		).toBe(true);
	});
	test("Space inside a control of the card does not", () => {
		expect(isCardToggleKey({ key: " ", target: {}, currentTarget: card })).toBe(
			false,
		);
	});
	test("other keys and modified Space do not", () => {
		expect(
			isCardToggleKey({ key: "Enter", target: card, currentTarget: card }),
		).toBe(false);
		expect(
			isCardToggleKey({
				key: " ",
				target: card,
				currentTarget: card,
				ctrlKey: true,
			}),
		).toBe(false);
	});
});

describe("story folds", () => {
	test("flattenRuns lists parents before their children", () => {
		const r = run(
			"A",
			{},
			{ children: [run("B", {}, { children: [run("C")] })] },
		);
		expect(flattenRuns([r, run("D")]).map((x) => x.ref)).toEqual([
			"run:A",
			"run:B",
			"run:C",
			"run:D",
		]);
	});

	test("lastSettled is the newest settled run, ignoring live ones", () => {
		const detail = lastSettled([
			run("A", { startedAt: at(8), finishedAt: at(9), costUsd: 0.1 }),
			run("B", {
				startedAt: at(10),
				finishedAt: at(11),
				costUsd: 0.62,
				model: "claude-opus-4-7",
			}),
			run("C", { state: "running", startedAt: at(12), finishedAt: null }),
		]);
		expect(detail).toMatchObject({ costUsd: 0.62, state: "completed" });
		expect(detail?.at).toEqual(at(11));
		expect(
			lastSettled([run("C", { state: "running", finishedAt: null })]),
		).toBeNull();
	});

	test("outcomeTail names time, model and cost, and drops what is missing", () => {
		const now = at(13).getTime();
		expect(
			outcomeTail(
				{
					at: at(11),
					model: "claude-opus-4-7",
					costUsd: 0.62,
					state: "completed",
				},
				now,
			),
		).toBe("2h ago · opus · $0.62");
		expect(
			outcomeTail(
				{ at: at(11), model: null, costUsd: null, state: "completed" },
				now,
			),
		).toBe("2h ago");
	});

	test("the brain intent shows only when its decision is newer than the latest run", () => {
		const r = run("A", { startedAt: at(10) });
		expect(pendingIntent([r, decision(12)])?.tool).toBe("spawn_attempts");
		expect(pendingIntent([r, decision(9)])).toBeNull();
		expect(pendingIntent([r])).toBeNull();
	});

	test("the intent line renders from the story, and not when a run is newer", () => {
		const h = harness();
		seedStory(h, [run("A", { startedAt: at(10) }), decision(12)]);
		let html = renderToString(
			wrap(h, <CardSubtree project={PROJECT} taskId="T-1" />),
		);
		expect(html).toContain("brain: spawn attempts");
		expect(html).toContain('data-glyph="diamond"');
		expect(html).toContain("verify flaked twice");
		seedStory(h, [run("A", { startedAt: at(13) }), decision(12)]);
		html = renderToString(
			wrap(h, <CardSubtree project={PROJECT} taskId="T-1" />),
		);
		expect(html).not.toContain("brain:");
	});
});
