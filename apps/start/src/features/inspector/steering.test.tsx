import { describe, expect, test } from "bun:test";
import type { AppRouter } from "@mfw/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { renderToString as renderRaw } from "react-dom/server";

import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import {
	canOverride,
	decisionRuns,
	humanRowOf,
	letBrainDecideText,
	outcomeSummary,
	wakeLabel,
} from "../brain/steering";
import { inlineKind } from "../home/NeedsQueue";
import { DecisionRow } from "./DecisionRow";
import { LetBrainDecide, MessageBrain } from "./MessageBrain";
import {
	OverrideBody,
	type OverridePreview,
	overrideBlocked,
} from "./OverrideDialog";

process.env.BASE_URL ??= "/";

const render = (el: Parameters<typeof renderRaw>[0]) =>
	renderRaw(el).replaceAll("<!-- -->", "");

function harness() {
	const link: TRPCLink<AppRouter> =
		() =>
		({ op }) =>
			observable((observer) => {
				observer.error(new Error(`no network: ${op.path}`) as never);
			});
	const client = createTRPCClient<AppRouter>({ links: [link] });
	const queryClient = new QueryClient();
	createTRPCOptionsProxy<AppRouter>({ client, queryClient });
	return { client, queryClient };
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

function decision(over: Record<string, unknown> = {}) {
	return {
		id: 512,
		ts: new Date(),
		role: "brain",
		taskId: "T-1",
		subjectRunId: null,
		model: "opus",
		status: "ok",
		action: "spawn",
		reason: "T-1 is ready and unblocks two others",
		input: { taskId: "T-1", role: "implement" },
		output: {
			status: "applied",
			result: { runIds: ["01RUNAAAAAA"] },
		},
		turnRunId: "TURN2",
		kind: "action",
		alternatives: [],
		confidence: "high",
		contextRefs: null,
		outcome: null,
		overriddenBy: null,
		...over,
	};
}

const row = (d: Record<string, unknown>, open = true) =>
	render(
		wrap(
			harness(),
			<ul>
				<DecisionRow project="alpha" decision={d as never} defaultOpen={open} />
			</ul>,
		),
	);

describe("a decision row links to its turn, runs and task", () => {
	test("the three links an audit needs", () => {
		const html = row(decision());
		expect(html).toContain("node=turn:TURN2");
		expect(html).toContain("node=run:01RUNAAAAAA");
		expect(html).toContain("node=task:T-1");
	});
});

describe("outcome chips and the fold", () => {
	test("a first-pass merge reads as such, with cost and time", () => {
		const outcome = {
			final: "merged",
			firstPass: true,
			repairs: 0,
			reviewRounds: 0,
			costUsd: 0.42,
			durationMs: 12 * 60_000,
			chains: 1,
		};
		const html = row(decision({ outcome }));
		expect(html).toContain("merged first pass");
		expect(html).toContain("Outcome: merged first pass · $0.42 · 12m");
	});

	test("a repaired merge and an abandoned chain", () => {
		expect(
			outcomeSummary({ final: "merged", firstPass: false, repairs: 2 }),
		).toBe("merged after 2 repairs");
		expect(outcomeSummary({ final: "abandoned" })).toBe("abandoned");
		expect(outcomeSummary(null)).toBeNull();
		expect(row(decision({ outcome: { final: "abandoned" } }), false)).toContain(
			"abandoned",
		);
	});
});

describe("overrides", () => {
	test("only an applied or accepted brain call that is not already overridden offers Override", () => {
		expect(row(decision())).toContain("Override</button>");
		expect(row(decision({ overriddenBy: 600 }))).not.toContain(
			"Override</button>",
		);
		expect(row(decision({ output: { status: "rejected" } }))).not.toContain(
			"Override</button>",
		);
		expect(canOverride(decision({ kind: "plan" }) as never)).toBe(false);
		expect(canOverride(decision({ role: "human" }) as never)).toBe(false);
		expect(
			canOverride(decision({ output: { status: "accepted" } }) as never),
		).toBe(true);
	});

	test("the dialog body shows the inverse operation and requires a reason", () => {
		const preview = {
			decisionId: 512,
			tool: "set_status",
			taskId: "T-1",
			state: "ready",
			overriddenBy: null,
			summary: "move T-1 back to backlog",
			steps: [
				{
					op: "set_status",
					taskId: "T-1",
					to: "backlog",
					summary: "move T-1 back to backlog",
				},
			],
		} as OverridePreview;
		const html = render(
			wrap(
				harness(),
				<OverrideBody preview={preview} reason="" onReason={() => {}} />,
			),
		);
		expect(html).toContain("Overriding set status will");
		expect(html).toContain("move T-1 back to backlog");
		expect(html).toContain("required");
		expect(overrideBlocked(preview, "")).toBe("A reason is required.");
		expect(overrideBlocked(preview, "  ")).toBe("A reason is required.");
		expect(overrideBlocked(preview, "it was the spike")).toBeNull();
		expect(overrideBlocked(undefined, "x")).not.toBeNull();
		expect(overrideBlocked({ ...preview, state: "overridden" }, "x")).toBe(
			"Already overridden.",
		);
	});

	test("a call with no inverse says it only records the disagreement", () => {
		const preview = {
			decisionId: 9,
			tool: "steer",
			taskId: null,
			state: "acknowledge",
			overriddenBy: null,
			summary:
				"steer has no inverse operation; overriding records your disagreement and tells the brain",
			steps: [],
		} as OverridePreview;
		const html = render(
			wrap(
				harness(),
				<OverrideBody preview={preview} reason="" onReason={() => {}} />,
			),
		);
		expect(html).toContain("no inverse operation");
		expect(overrideBlocked(preview, "disagree")).toBeNull();
	});

	test("the override appears in the feed as the person's own row", () => {
		const d = decision({
			id: 600,
			role: "human",
			kind: "override",
			action: "override set_status",
			reason: "it was the migration spike",
			input: {
				overriddenDecisionId: 512,
				tool: "set_status",
				inverse: "move T-1 back to backlog",
			},
			turnRunId: null,
		});
		expect(humanRowOf(d as never)?.label).toBe("you overrode decision 512");
		const html = row(d);
		expect(html).toContain("you overrode decision 512");
		expect(html).toContain("move T-1 back to backlog");
		expect(html).toContain("it was the migration spike");
	});

	test("the original shows overridden with a link to the override", () => {
		const html = row(decision({ overriddenBy: 600 }));
		expect(html).toContain("overridden");
		expect(html).toContain("node=decision:600");
	});
});

describe("message the brain", () => {
	test("the box names what it is about", () => {
		const html = render(
			wrap(harness(), <MessageBrain project="alpha" about="task:T-1" />),
		);
		expect(html).toContain("Message the brain about task:T-1");
		expect(html).toContain("Send");
	});

	test("a turn woken by a human reads as woken by you", () => {
		expect(wakeLabel("human")).toBe("woken by you");
		expect(wakeLabel("settled")).toBe("settled");
	});

	test("a notify_human item in the needs queue offers Let the brain decide", () => {
		expect(inlineKind("brain_notice")).toBe("brain");
		expect(inlineKind("brain_stuck")).toBe("open");
		const html = render(
			wrap(
				harness(),
				<LetBrainDecide project="alpha" title="Pick a database" taskId="T-1" />,
			),
		);
		expect(html).toContain("Let the brain decide");
		expect(letBrainDecideText("Pick a database")).toContain("Pick a database");
	});

	test("what a decision acted on is listed once", () => {
		expect(
			decisionRuns({
				output: {
					result: { runIds: ["a", "b"] },
					effects: { launched: ["a"] },
				},
				input: { runId: "c" },
				subjectRunId: "c",
			} as never),
		).toEqual(["a", "b", "c"]);
	});
});
