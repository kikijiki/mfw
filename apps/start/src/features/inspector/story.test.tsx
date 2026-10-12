import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AppRouter } from "@mfw/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { applyEvent } from "../../lib/live";
import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import {
	groupByDay,
	newestFirst,
	type StoryEntry,
	StoryEntryView,
	type StoryPage,
	type StoryRunEntry,
} from "./story";
import {
	fetchStoryPage,
	STORY_PAGE_SIZE,
	storyKey,
	TaskStory,
} from "./TaskStory";

// AppLink prefixes hrefs with the build-time mount, which bun test does not define.
import.meta.env.BASE_URL ??= "/";

const at = (h: number, day = 12) => new Date(2026, 9, day, h, 5);

const caps = {
	verified: true,
	steer: true,
	interrupt: true,
	approvals: true,
};

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

const ALL_KINDS: StoryEntry[] = [
	run(
		"R1",
		{},
		{
			verify: [
				{ check: "typecheck", passed: false, classification: "task_failure" },
				{ check: "lint", passed: true },
			],
			verdicts: [
				{
					id: "v1",
					at: at(11),
					verdict: "changes_requested",
					mode: "critic",
					round: 1,
					reviewerHarness: "codex-cli",
					reviewerModel: "gpt-5",
					decisionId: null,
				},
			],
			children: [run("R2", { relation: "repair", label: "T-1#repair" })],
		},
	),
	{
		kind: "decision",
		at: at(12),
		id: 7,
		role: "critic",
		tool: "request_changes",
		target: "task:T-1",
		subjectRunId: "R1",
		rationale: "type narrowing missing in parseKeys",
		outcome: "applied",
		effects: [],
	},
	{
		kind: "status",
		at: at(13),
		from: "ready",
		to: "in_progress",
		actor: "human",
		reason: "go",
	},
	{ kind: "edit", at: at(14), actor: "human", fields: ["owns", "title"] },
	{
		kind: "merge",
		at: at(15),
		state: "completed",
		runRef: "run:R1",
		sha: "0123456789abcdef",
	},
	{
		kind: "question",
		at: at(16),
		runRef: "run:R1",
		question: "Reject or migrate v1 keys?",
		answer: "migrate",
		answeredBy: "human",
	},
	{ kind: "hold", at: at(17), reason: "waiting for the gpu slot" },
	{ kind: "created", at: at(9), by: "brain" },
	{
		kind: "verdict",
		at: at(18),
		runRef: "run:GONE",
		id: "v2",
		verdict: "accept",
		mode: "human",
		round: 2,
		reviewerHarness: null,
		reviewerModel: null,
		decisionId: null,
	},
	{
		kind: "group",
		at: at(8),
		ref: "group:G1",
		group: {
			kind: "competing",
			selection: "brain",
			status: "selecting",
			winnerRunId: "A1",
			createdBy: "decision:7",
			closedAt: null,
		},
		attempts: [
			run(
				"A1",
				{ role: "attempt" },
				{
					attempt: { groupRef: "group:G1", role: "attempt", winner: true },
				},
			),
			run(
				"A2",
				{ role: "attempt" },
				{
					attempt: { groupRef: "group:G1", role: "attempt", winner: false },
				},
			),
		],
	},
];

function harness() {
	const queryClient = new QueryClient();
	const client = createTRPCClient<AppRouter>({ links: [] });
	const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
	const render = (node: ReactElement) =>
		renderToStaticMarkup(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(TRPCProvider, {
					trpcClient: client,
					queryClient,
					// biome-ignore lint/correctness/noChildrenProp: createElement(TRPCProvider, props) needs children inside props to typecheck
					children: createElement(ToastProvider, null, node),
				}),
			),
		);
	return { queryClient, client, trpc, render };
}

describe("every StoryEntry kind renders", () => {
	const { render } = harness();
	const html = (entry: StoryEntry) =>
		render(
			createElement(
				"ul",
				null,
				createElement(StoryEntryView, { entry, project: "alpha" }),
			),
		);

	test("each kind produces a row carrying its kind", () => {
		for (const entry of ALL_KINDS) {
			expect(html(entry)).toContain(`data-kind="${entry.kind}"`);
		}
		expect(new Set(ALL_KINDS.map((e) => e.kind))).toEqual(
			new Set([
				"run",
				"decision",
				"status",
				"edit",
				"merge",
				"question",
				"hold",
				"created",
				"verdict",
				"group",
			]),
		);
	});

	test("a run shows its checks, verdicts and nested repair run", () => {
		const out = html(ALL_KINDS[0] as StoryEntry);
		expect(out).toContain('data-glyph="cross"');
		expect(out).toContain("typecheck");
		expect(out).toContain('data-glyph="check"');
		expect(out).toContain("lint");
		expect(out).toContain("changes requested");
		expect(out).toContain('data-run="R2"');
		expect(out).toContain('data-depth="1"');
		expect(out).toContain("repair");
	});

	test("decision, status, edit, merge, question, hold and created carry their content", () => {
		expect(html(ALL_KINDS[1] as StoryEntry)).toContain(
			"type narrowing missing",
		);
		const status = html(ALL_KINDS[2] as StoryEntry);
		expect(status).toContain("human: moved");
		expect(status).toContain("go");
		expect(html(ALL_KINDS[3] as StoryEntry)).toContain("edited owns, title");
		expect(html(ALL_KINDS[4] as StoryEntry)).toContain("01234567");
		const q = html(ALL_KINDS[5] as StoryEntry);
		expect(q).toContain("Reject or migrate v1 keys?");
		expect(q).toContain("migrate");
		expect(html(ALL_KINDS[6] as StoryEntry)).toContain(
			"waiting for the gpu slot",
		);
		expect(html(ALL_KINDS[7] as StoryEntry)).toContain("created by brain");
	});
});

describe("attempt groups in the Story", () => {
	const { render } = harness();
	const out = render(
		createElement(
			"ul",
			null,
			createElement(StoryEntryView, {
				entry: ALL_KINDS[ALL_KINDS.length - 1] as StoryEntry,
				project: "alpha",
			}),
		),
	);

	test("a competing group nests its attempts under one compete block with the winner starred", () => {
		expect(out).toContain('data-group="group:G1"');
		expect(out).toContain('data-glyph="compete"');
		expect(out).toContain("Competing attempts");
		expect(out).toContain("winner chosen, merging");
		expect(out).toContain('data-run="A1"');
		expect(out).toContain('data-run="A2"');
		// exactly one attempt wears the star
		expect(out.split('data-testid="winner-star"').length - 1).toBe(1);
		expect(out).toContain("decision:7");
	});

	test("it links to the compare inspector for the group", () => {
		expect(out).toContain("node=group");
		expect(out).toContain("Compare");
	});
});

describe("live run blocks", () => {
	const live = run("LIVE", {
		state: "running",
		activity: "working",
		label: "T-1",
	});
	const seed = (h: ReturnType<typeof harness>) => {
		h.queryClient.setQueryData(h.trpc.runs.active.queryKey(), [
			{
				project: "alpha",
				runId: "LIVE",
				kind: "task",
				state: "running",
				label: "T-1",
				model: "m",
				providerId: null,
				reasoningEffort: null,
				taskId: "T-1",
				taskTitle: null,
				attempt: 1,
				capabilities: caps,
				steerable: true,
				startedAt: 0,
				activity: null,
				activityDetail: null,
				scopeSample: null,
				route: null,
			} as never,
		]);
	};
	const view = (h: ReturnType<typeof harness>, defaultOpen: boolean) =>
		h.render(
			createElement(
				"ul",
				null,
				createElement(StoryEntryView, {
					entry: live,
					project: "alpha",
					defaultOpen,
				}),
			),
		);

	test("collapsed: no console, so no transcript tail and no live.runOutput stream", () => {
		const h = harness();
		seed(h);
		const html = view(h, false);
		expect(html).toContain('aria-expanded="false"');
		expect(html).toContain("Console, steer");
		expect(html).not.toContain("Steer the agent");
		expect(html).not.toContain("Open transcript");
	});

	test("expanded: the console mounts with steer", () => {
		const h = harness();
		seed(h);
		const html = view(h, true);
		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain("Steer the agent");
	});

	test("the source gates RunConsole behind the open flag", () => {
		const src = readFileSync(join(import.meta.dir, "story.tsx"), "utf8");
		expect(src).toContain("{open ? (\n\t\t\t\t<RunConsole");
	});

	test("a finished run never shows the console toggle", () => {
		const h = harness();
		const html = h.render(
			createElement(
				"ul",
				null,
				createElement(StoryEntryView, { entry: run("DONE"), project: "alpha" }),
			),
		);
		expect(html).not.toContain("Console, steer");
	});
});

describe("ordering and days", () => {
	test("pages flatten newest first, each page reversed", () => {
		const page = (...hours: number[]): StoryPage => ({
			entries: hours.map((h) => ({ kind: "hold", at: at(h), reason: `h${h}` })),
			cursor: null,
		});
		const flat = newestFirst([page(10, 11, 12), page(7, 8, 9)]);
		expect(flat.map((e) => (e.kind === "hold" ? e.reason : ""))).toEqual([
			"h12",
			"h11",
			"h10",
			"h9",
			"h8",
			"h7",
		]);
	});

	test("entries group by local day", () => {
		const entries: StoryEntry[] = [
			{ kind: "hold", at: at(10, 12), reason: "a" },
			{ kind: "hold", at: at(9, 12), reason: "b" },
			{ kind: "hold", at: at(22, 11), reason: "c" },
		];
		const groups = groupByDay(entries);
		expect(groups.map((g) => [g.day, g.entries.length])).toEqual([
			["2026-10-12", 2],
			["2026-10-11", 1],
		]);
	});
});

describe("paging by cursor", () => {
	test("the first request has no cursor; older ones pass it as `before`", async () => {
		const calls: unknown[] = [];
		const client = {
			node: {
				story: {
					query: async (input: unknown) => {
						calls.push(input);
						return { entries: [], cursor: null };
					},
				},
			},
		};
		await fetchStoryPage(client, { project: "alpha", taskId: "T-1" });
		await fetchStoryPage(client, {
			project: "alpha",
			taskId: "T-1",
			before: "CURSOR",
		});
		expect(calls).toEqual([
			{ project: "alpha", ref: "task:T-1", limit: STORY_PAGE_SIZE },
			{
				project: "alpha",
				ref: "task:T-1",
				before: "CURSOR",
				limit: STORY_PAGE_SIZE,
			},
		]);
	});

	const seeded = (cursor: string | null) => {
		const h = harness();
		h.queryClient.setQueryData(storyKey(h.trpc, "alpha", "T-1"), {
			pages: [
				{ entries: [{ kind: "hold", at: at(10), reason: "latest" }], cursor },
			],
			pageParams: [undefined],
		});
		return h.render(
			createElement(TaskStory, { project: "alpha", taskId: "T-1" }),
		);
	};

	test("'Load older' appears only while the last page has a cursor", () => {
		expect(seeded("NEXT")).toContain("Load older");
		const end = seeded(null);
		expect(end).toContain("latest");
		expect(end).not.toContain("Load older");
	});
});

describe("live invalidation", () => {
	test("a task status event invalidates the cached story pages", () => {
		const h = harness();
		const key = storyKey(h.trpc, "alpha", "T-1");
		h.queryClient.setQueryData(key, { pages: [], pageParams: [] });
		expect(h.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
		applyEvent(h.queryClient, h.trpc, {
			project: "alpha",
			event: {
				type: "task.status_changed",
				taskId: "T-1",
				seq: 1,
				ts: Date.now(),
				payload: { from: "ready", to: "in_progress" },
			} as never,
		});
		expect(h.queryClient.getQueryState(key)?.isInvalidated).toBe(true);
	});

	test("another task's story is left alone", () => {
		const h = harness();
		const key = storyKey(h.trpc, "alpha", "T-2");
		h.queryClient.setQueryData(key, { pages: [], pageParams: [] });
		applyEvent(h.queryClient, h.trpc, {
			project: "alpha",
			event: {
				type: "task.status_changed",
				taskId: "T-1",
				seq: 1,
				ts: Date.now(),
				payload: { from: "ready", to: "in_progress" },
			} as never,
		});
		expect(h.queryClient.getQueryState(key)?.isInvalidated).toBe(false);
	});
});

describe("a brain decision on the spine", () => {
	const { render } = harness();
	const entry = {
		kind: "decision",
		at: at(12),
		id: 31,
		role: "brain",
		tool: "spawn_attempts",
		target: "task:T-1",
		subjectRunId: null,
		rationale: "two plausible parsers",
		outcome: "proposed",
		effects: [],
		brain: {
			kind: "action",
			actionState: "proposed",
			confidence: "medium",
			alternatives: [{ option: "one attempt", why_not: "design is open" }],
			turnRunId: "TURN1",
			settled: null,
			overriddenBy: null,
		},
	} as unknown as StoryEntry;
	const html = (e: StoryEntry) =>
		render(
			createElement(
				"ul",
				null,
				createElement(StoryEntryView, { entry: e, project: "alpha" }),
			),
		);
	const brainOf = (e: StoryEntry) =>
		(e as unknown as { brain: Record<string, unknown> }).brain;

	test("shows who, confidence, the shadow chip, rationale and alternatives", () => {
		const out = html(entry);
		expect(out).toContain("BRAIN");
		expect(out).toContain("spawn attempts");
		expect(out).toContain("medium");
		expect(out).toContain("shadow: proposed");
		expect(out).toContain("two plausible parsers");
		expect(out).toContain("one attempt");
		expect(out).toContain("decision 31");
	});

	test("a decision that was applied has no shadow chip", () => {
		const applied = {
			...entry,
			outcome: "applied",
			brain: { ...brainOf(entry), actionState: "applied" },
		} as unknown as StoryEntry;
		expect(html(applied)).not.toContain("shadow: proposed");
	});

	test("an escalation is loud", () => {
		const notify = {
			...entry,
			tool: "notify_human",
			brain: {
				...brainOf(entry),
				notify: { kind: "credential", title: "Need an API key" },
			},
		} as unknown as StoryEntry;
		const out = html(notify);
		expect(out).toContain("needs you");
		expect(out).toContain("Need an API key");
	});
});
