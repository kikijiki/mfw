import { describe, expect, test } from "bun:test";
import type { AppRouter } from "@mfw/api";
import type { InboxItem } from "@mfw/daemon/inbox";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { TRPCProvider } from "../../lib/trpc";
import { nextNeedTarget } from "../home/needs";
import { PresenceBar } from "./PresenceBar";
import {
	COLLAPSE_AFTER,
	type PresenceBrain,
	type PresenceRun,
	presenceView,
	projectTarget,
	runTarget,
} from "./presence";

const run = (
	project: string,
	n: number,
	over: Partial<PresenceRun> = {},
): PresenceRun => ({
	project,
	runId: `${project}-run-${n}`,
	state: "running",
	activity: "working",
	taskId: `${project.toUpperCase()}-${n}`,
	model: "claude-sonnet",
	startedAt: n,
	...over,
});

const item = (
	project: string,
	n: number,
	over: Partial<InboxItem> = {},
): InboxItem => ({
	id: `${project}:${n}`,
	project,
	kind: "needs_answer",
	ref: `run:${project}:${n}`,
	severity: "attention",
	title: `Question ${n}`,
	detail: "",
	ts: 1000 - n,
	...over,
});

describe("presenceView", () => {
	test("one chip per project with a dot per live run", () => {
		const view = presenceView(
			[run("mfw", 1), run("mfw", 2), run("jev", 1)],
			[],
		);
		expect(view.projects.map((p) => [p.project, p.dots.length])).toEqual([
			["jev", 1],
			["mfw", 2],
		]);
		expect(view.runTotal).toBe(3);
		expect(view.projects.every((p) => !p.collapsed)).toBe(true);
	});

	test("a dot is coloured by the run's activity, with a word for it", () => {
		const view = presenceView(
			[run("mfw", 1, { activity: "awaiting_approval" }), run("mfw", 2)],
			[],
		);
		const [approval, working] = view.projects[0]?.dots ?? [];
		expect(approval?.look.label).toBe("awaiting approval");
		expect(working?.look.label).toBe("working");
		expect(approval?.look.token).not.toBe(working?.look.token);
		expect(approval?.peek).toContain("MFW-1");
	});

	test(`more than ${COLLAPSE_AFTER} runs in a project collapse`, () => {
		const five = Array.from({ length: COLLAPSE_AFTER }, (_, i) =>
			run("mfw", i),
		);
		expect(presenceView(five, []).projects[0]?.collapsed).toBe(false);
		const six = [...five, run("mfw", 99)];
		const p = presenceView(six, []).projects[0];
		expect(p?.collapsed).toBe(true);
		expect(p?.runCount).toBe(COLLAPSE_AFTER + 1);
	});

	test("projects that need you sort first, and counts are per project", () => {
		const view = presenceView(
			[run("a", 1), run("b", 1)],
			[item("b", 1), item("b", 2), item("c", 1)],
		);
		expect(view.projects.map((p) => [p.project, p.needs])).toEqual([
			["b", 2],
			["c", 1],
			["a", 0],
		]);
	});

	test("the needs list is exactly inbox.list, oldest first, and its length is the badge", () => {
		const inbox = [item("mfw", 1), item("jev", 2), item("mfw", 3)];
		const view = presenceView([], inbox);
		expect(view.needsTotal).toBe(inbox.length);
		expect(new Set(view.needs.map((i) => i.id))).toEqual(
			new Set(inbox.map((i) => i.id)),
		);
		// ts is 1000 - n: n=3 is the oldest.
		expect(view.needs[0]?.id).toBe("mfw:3");
	});

	test("n goes to the oldest item", () => {
		const inbox = [
			item("mfw", 1, { kind: "approval_pending", runId: "R1" }),
			item("jev", 2, { kind: "approval_pending", runId: "R2" }),
		];
		expect(nextNeedTarget(inbox)).toBe("/p/jev/runs/R2");
		expect(nextNeedTarget([])).toBeNull();
	});
});

describe("PresenceBar render", () => {
	function render(
		runs: PresenceRun[],
		inbox: InboxItem[],
		brains: PresenceBrain[] = [],
	) {
		const queryClient = new QueryClient();
		const client = createTRPCClient<AppRouter>({ links: [] });
		const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
		queryClient.setQueryData(trpc.brain.states.queryKey(), brains as never);
		queryClient.setQueryData(trpc.runs.active.queryKey(), runs as never);
		queryClient.setQueryData(trpc.inbox.list.queryKey(), {
			items: inbox,
			counts: {
				total: inbox.length,
				critical: 0,
				attention: inbox.length,
			},
		} as never);
		return renderToStaticMarkup(
			createElement(
				QueryClientProvider,
				{ client: queryClient },
				createElement(TRPCProvider, {
					trpcClient: client,
					queryClient,
					// biome-ignore lint/correctness/noChildrenProp: createElement(TRPCProvider, props) needs children inside props to typecheck
					children: createElement(PresenceBar, { onNavigate: () => {} }),
				}),
			),
		);
	}

	test("shows the badge as the inbox length and collapses a crowded project", () => {
		const runs = Array.from({ length: 7 }, (_, i) => run("mfw", i));
		const html = render(runs, [item("mfw", 1), item("mfw", 2)]);
		expect(html).toContain("live runs");
		expect(html).toContain("×7");
		expect(html).toContain('<span class="mfw-num">2</span>');
		expect(html).toContain("need you");
	});

	test("a running turn is a filled diamond, a stuck brain shows the cross; no brain, no glyph", () => {
		const brain = (
			project: string,
			state: PresenceBrain["state"],
			enabled = true,
		): PresenceBrain => ({
			project,
			enabled,
			state,
			failures: state === "failed" ? 3 : 0,
			error: state === "failed" ? "boom" : null,
		});
		const html = render(
			[run("mfw", 1)],
			[],
			[
				brain("mfw", "turn"),
				brain("jev", "failed"),
				brain("off", "off", false),
			],
		);
		expect(html).toContain('aria-label="brain turn running"');
		expect(html).not.toContain("mfw-pulse");
		// A stuck brain gets its own chip even with no run live.
		expect(html).toContain("Brain: stuck after 3 failed turns (boom)");
		expect(html).toContain('aria-label="brain failed"');
		expect(html).toContain("jev");
		// A project with no brain draws no brain glyph and no chip of its own.
		expect(html).not.toContain(">off<");
	});

	test("with nothing live and nothing waiting, the bar stays and the count is zero", () => {
		const html = render([], []);
		expect(html).toContain('aria-label="Presence"');
		expect(html).toContain('<span class="mfw-num">0</span>');
		expect(html).not.toContain("×");
	});
});

describe("where the bar's marks go", () => {
	test("a project chip opens the project's Flow, a run dot opens Flow with the run selected", () => {
		expect(projectTarget("mfw")).toBe("/p/mfw/flow");
		expect(runTarget("mfw", "01JQ2")).toBe("/p/mfw/flow?node=run:01JQ2");
		expect(runTarget("a b", "R1")).toBe("/p/a%20b/flow?node=run:R1");
	});
});
