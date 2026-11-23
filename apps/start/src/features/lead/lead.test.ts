import { describe, expect, test } from "bun:test";
import type { AppRouter } from "@mfw/api";
import { DIRECTION_MAX_CHARS } from "@mfw/daemon/brain-runtime/directions";
import type { Headline } from "@mfw/daemon/headlines";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import { LeadPage } from "./LeadPage";
import {
	brainParagraph,
	DIRECTION_CHARS,
	directionBadge,
	directionsOpen,
	drillLinks,
	headlineFor,
	intentSentence,
	leadTarget,
	PARAGRAPH_CHARS,
} from "./lead";

const headline: Headline = {
	project: "mfw",
	text: "Landed 7, needs you 1; main green; spend 62%",
	parts: [
		{ key: "landed", text: "Landed 7", link: "landed" },
		{ key: "needs_you", text: "needs you 1", link: "needs_you" },
		{ key: "main", text: "main green", link: "main" },
		{ key: "spend", text: "spend 62%", link: "budgets" },
	],
	landedToday: 7,
	needsYou: 1,
	spendFraction: 0.62,
};

describe("lead rules", () => {
	test("the headline is this project's, or null", () => {
		expect(headlineFor([headline], "mfw")).toBe(headline);
		expect(headlineFor([headline], "other")).toBeNull();
		expect(headlineFor(undefined, "mfw")).toBeNull();
	});

	test("every headline number leads somewhere; needs you stays on Lead", () => {
		expect(leadTarget("mfw", "needs_you")).toBe("/p/mfw#needs-you");
		expect(leadTarget("mfw", "landed")).toBe("/p/mfw/repo/commits");
		expect(leadTarget("mfw", "main")).toBe("/p/mfw/repo");
		expect(leadTarget("mfw", "budgets")).toBe("/p/mfw/settings");
	});

	test("the brain paragraph is the plan's first paragraph", () => {
		expect(brainParagraph(null)).toBeNull();
		expect(brainParagraph("  \n ")).toBeNull();
		expect(brainParagraph("One line.")).toEqual({
			text: "One line.",
			clipped: false,
		});
		expect(brainParagraph("First.\n\nSecond.")).toEqual({
			text: "First.",
			clipped: true,
		});
		const long = brainParagraph("x".repeat(PARAGRAPH_CHARS + 50));
		expect(long?.clipped).toBe(true);
		expect(long?.text.endsWith("…")).toBe(true);
	});

	test("the intent is the newest standing action, proposed in shadow mode", () => {
		expect(intentSentence([])).toBeNull();
		expect(intentSentence(undefined)).toBeNull();
		const s = intentSentence([
			{ taskId: "MFW-2", tool: "spawn", rationale: "ready", state: "applied" },
			{ taskId: "MFW-3", tool: "stop", rationale: "", state: null },
		]);
		expect(s).toMatchObject({ taskId: "MFW-2", proposed: false, more: 1 });
		expect(s?.text).toContain("MFW-2");
		expect(s?.text).toContain("ready");
		const shadow = intentSentence([
			{ taskId: "MFW-2", tool: "spawn", rationale: "", state: "proposed" },
		]);
		expect(shadow?.proposed).toBe(true);
		expect(shadow?.text.startsWith("Would ")).toBe(true);
	});

	test("drill-down reaches Board, Flow, docs, repo and triggers", () => {
		const to = drillLinks("mfw").map((l) => l.to);
		expect(to).toContain("/p/mfw/board");
		expect(to).toContain("/p/mfw/flow");
		expect(to).toContain("/p/mfw/triggers");
	});
});

describe("direction rules", () => {
	test("the box's limit is the server's", () => {
		expect(DIRECTION_CHARS).toBe(DIRECTION_MAX_CHARS);
	});

	test("each status reads plainly, and an unreceived one is not drafting", () => {
		expect(directionBadge("drafting", false).label).toBe(
			"waiting for the brain",
		);
		expect(directionBadge("drafting", true).label).toBe("drafting");
		expect(directionBadge("held", true).tone).toBe("warn");
		expect(directionBadge("no_draft", true).label).toBe("no draft");
	});

	test("polling stops once every direction is settled", () => {
		expect(directionsOpen([{ status: "done" }, { status: "no_draft" }])).toBe(
			false,
		);
		expect(directionsOpen([{ status: "held" }])).toBe(true);
		expect(directionsOpen(undefined)).toBe(false);
	});
});

function render(seed: {
	headlines?: Headline[];
	plan?: string;
	directions?: unknown[];
	brainEnabled?: boolean;
}): string {
	const queryClient = new QueryClient();
	const client = createTRPCClient<AppRouter>({ links: [] });
	const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
	const project = "mfw";
	queryClient.setQueryData(trpc.inbox.list.queryKey(), {
		items: [],
		counts: { total: 0, critical: 0, attention: 0 },
	} as never);
	queryClient.setQueryData(
		trpc.inbox.headlines.queryKey(),
		(seed.headlines ?? []) as never,
	);
	queryClient.setQueryData(trpc.runs.active.queryKey(), [] as never);
	queryClient.setQueryData(trpc.brain.states.queryKey(), [
		{
			project,
			enabled: seed.brainEnabled ?? true,
			state: "idle",
			failures: 0,
			error: null,
		},
	] as never);
	queryClient.setQueryData(
		trpc.brain.directions.queryKey({ project }),
		(seed.directions ?? []) as never,
	);
	queryClient.setQueryData(
		trpc.brain.decisions.queryKey({ project, kind: "plan", limit: 1 }),
		(seed.plan ? [{ reason: seed.plan }] : []) as never,
	);
	queryClient.setQueryData(
		trpc.brain.intents.queryKey({ project }),
		[] as never,
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
					children: createElement(LeadPage, { project }),
				}),
			),
		),
	);
}

describe("LeadPage", () => {
	test("headline first, then the brain's paragraph, labelled as its words", () => {
		const html = render({
			headlines: [headline],
			plan: "Ship the importer first.\n\nThen the exporter.",
		});
		expect(html).toContain('data-lead-headline="mfw"');
		expect(html).toContain("Landed 7");
		expect(html).toContain("/p/mfw#needs-you");
		expect(html).toContain("Ship the importer first.");
		expect(html).not.toContain("Then the exporter.");
		expect(html).toContain("brain&#x27;s words");
		expect(html).toContain("Read the full plan");
		expect(html.indexOf("Landed 7")).toBeLessThan(
			html.indexOf("Ship the importer first."),
		);
	});

	test("the direction box is one text field and no form fields", () => {
		const html = render({});
		expect(html).toContain('aria-label="Give direction"');
		expect(html.match(/<textarea/g)).toHaveLength(1);
		expect(html).toContain(`maxLength="${DIRECTION_CHARS}"`);
	});

	test("the box is disabled while the brain is off", () => {
		const html = render({ brainEnabled: false });
		expect(html).toMatch(/<textarea[^>]*disabled/);
	});

	test("a direction's text renders as inert text", () => {
		const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
		const html = render({
			directions: [
				{
					id: "D1",
					text: evil,
					at: 1_800_000_000_000,
					status: "held",
					received: true,
					taskIds: ["MFW-9"],
					heldActionIds: ["A1"],
				},
			],
		});
		expect(html).not.toContain("<img src=x");
		expect(html).not.toContain("<script>alert");
		expect(html).toContain("&lt;img src=x");
		expect(html).toContain("held for you");
		expect(html).toContain("/p/mfw#needs-you");
		expect(html).toContain("MFW-9");
	});

	test("drill-down links and the needs section are present", () => {
		const html = render({ headlines: [headline] });
		expect(html).toContain('id="needs-you"');
		expect(html).toContain("/p/mfw/board");
		expect(html).toContain("/p/mfw/flow");
		expect(html).toContain("The brain has not written a plan yet.");
	});
});
