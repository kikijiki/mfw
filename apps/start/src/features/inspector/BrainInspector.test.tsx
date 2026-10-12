import { describe, expect, test } from "bun:test";
import type { AppRouter } from "@mfw/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { renderToString as renderRaw } from "react-dom/server";

import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import { BrainInspector, type BrainTab } from "./BrainInspector";
import { DecisionRow } from "./DecisionRow";

process.env.BASE_URL ??= "/";

const renderToString = (el: Parameters<typeof renderRaw>[0]) =>
	renderRaw(el).replaceAll("<!-- -->", "");

const PROJECT = "alpha";
const at = (m: number) => new Date(Date.now() - m * 60_000);

function harness() {
	const link: TRPCLink<AppRouter> =
		() =>
		({ op }) =>
			observable((observer) => {
				observer.error(new Error(`no network: ${op.path}`) as never);
			});
	const client = createTRPCClient<AppRouter>({ links: [link] });
	const queryClient = new QueryClient();
	const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
	return { client, queryClient, trpc };
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
		ts: at(10),
		role: "brain",
		taskId: "T-1",
		subjectRunId: null,
		model: "opus",
		status: "ok",
		action: "spawn_attempts",
		reason: "two plausible designs\nsecond line of the rationale",
		input: { taskId: "T-1" },
		output: { status: "proposed", dryRun: true },
		turnRunId: "TURN2",
		kind: "action",
		alternatives: [{ option: "one attempt", why_not: "design is open" }],
		confidence: "medium",
		contextRefs: { tasks: [{ id: "T-1", rev: 3 }] },
		outcome: null,
		overriddenBy: null,
		...over,
	};
}

const SESSION = {
	enabled: true,
	session: {
		id: "S1",
		status: "idle",
		generation: 3,
		harness: "claude-cli",
		model: "opus",
		effort: null,
		consecutiveFailures: 0,
		turnsLast24h: 41,
		spendLast24hUsd: 1.2,
		liveTurnRunId: null,
		lastTurn: {
			status: "ok",
			error: null,
			seq: 41,
			startedAt: at(4),
			endedAt: at(2),
		},
		nativeSessionId: "native-123",
		nativeHost: "box",
		contextTokens: 52_000,
		cursor: 900,
		createdAt: at(600),
		generationStartedAt: at(300),
	},
};

function seed(
	h: ReturnType<typeof harness>,
	over: {
		session?: unknown;
		decisions?: unknown[];
		turns?: unknown[];
		plans?: unknown[];
	} = {},
) {
	const q = h.queryClient;
	q.setQueryData(
		h.trpc.brain.session.queryKey({ project: PROJECT }),
		(over.session ?? SESSION) as never,
	);
	const decisions = over.decisions ?? [decision()];
	for (const limit of [50, 100]) {
		q.setQueryData(
			h.trpc.brain.decisions.queryKey({ project: PROJECT, limit }),
			decisions as never,
		);
	}
	q.setQueryData(
		h.trpc.brain.turns.queryKey({ project: PROJECT, limit: 100 }),
		(over.turns ?? [
			{
				runId: "TURN2",
				seq: 2,
				wakeClass: "frontier",
				status: "ok",
				eventsFrom: 4,
				eventsTo: 9,
				actionsCount: 1,
				usage: { deltaUsd: 0.04 },
				startedAt: at(11),
				endedAt: at(10),
				error: null,
			},
		]) as never,
	);
	q.setQueryData(
		h.trpc.brain.decisions.queryKey({
			project: PROJECT,
			kind: "plan",
			limit: 2,
		}),
		(over.plans ?? []) as never,
	);
	q.setQueryData(
		h.trpc.brain.decisions.queryKey({
			project: PROJECT,
			kind: "rollover",
			limit: 10,
		}),
		[] as never,
	);
}

const render = (h: ReturnType<typeof harness>, tab: BrainTab) =>
	renderToString(wrap(h, <BrainInspector project={PROJECT} tab={tab} />));

describe("BrainInspector tabs render the fixtures", () => {
	test("Decisions: grouped under their turn, with the shadow chip and rationale", () => {
		const h = harness();
		seed(h);
		const html = render(h, "decisions");
		expect(html).toContain("turn 2");
		expect(html).toContain("frontier");
		expect(html).toContain("spawn attempts");
		expect(html).toContain("two plausible designs");
		expect(html).toContain("shadow: proposed");
		expect(html).toContain("shadow: proposed vs pipeline");
		expect(html).toContain("medium");
		// The digest link opens the turn's run inspector.
		expect(html).toContain("node=turn:TURN2");
	});

	test("Decisions: no shadow chip once actions are applied", () => {
		const h = harness();
		seed(h, {
			decisions: [decision({ output: { status: "applied" } })],
		});
		const html = render(h, "decisions");
		expect(html).not.toContain("shadow: proposed");
		expect(html).toContain("pending");
	});

	test("Turns lists each turn with its wake class, actions and cost", () => {
		const h = harness();
		seed(h);
		const html = render(h, "turns");
		expect(html).toContain("#2");
		expect(html).toContain("frontier");
		expect(html).toContain("1 actions");
		expect(html).toContain("$0.04");
		expect(html).toContain("node=turn:TURN2");
	});

	test("Plan renders the latest plan as markdown", () => {
		const h = harness();
		seed(h, {
			plans: [
				decision({
					id: 9,
					kind: "plan",
					action: "set_plan",
					reason: "# Plan\n\n- ship U3",
				}),
			],
		});
		const html = render(h, "plan");
		expect(html).toContain("ship U3");
		expect(html).toContain("decision 9");
	});

	test("Plan without one says so", () => {
		const h = harness();
		seed(h);
		expect(render(h, "plan")).toContain("No plan yet");
	});

	test("Session shows generation, context and native session", () => {
		const h = harness();
		seed(h);
		h.queryClient.setQueryData(
			h.trpc.settings.get.queryKey({ project: PROJECT }),
			{
				values: {
					brain: {
						routes: [{ provider: "claude-cli", model: "opus" }],
						rolloverTokens: 120_000,
					},
				},
			} as never,
		);
		const html = render(h, "session");
		expect(html).toContain("native-123");
		expect(html).toContain("claude-cli");
		expect(html).toContain("before rollover");
		expect(html).toContain("Edit in project settings");
	});
});

describe("what needs a person is first", () => {
	test("an escalation is surfaced above the tabs", () => {
		const h = harness();
		seed(h, {
			decisions: [
				decision({
					id: 600,
					action: "notify_human",
					input: {
						kind: "credential",
						title: "Need an API key",
						body: "for the deploy",
						blocking: ["T-7"],
					},
				}),
			],
		});
		const html = render(h, "turns");
		expect(html).toContain('data-testid="brain-escalations"');
		expect(html).toContain("Need an API key");
		expect(html).toContain("blocks");
	});

	test("a failed brain shows the stuck banner and a retry", () => {
		const h = harness();
		seed(h, {
			session: {
				enabled: true,
				session: {
					...SESSION.session,
					status: "failed",
					consecutiveFailures: 3,
					lastTurn: {
						status: "failed",
						error: "no conversation found",
						seq: 5,
						startedAt: at(3),
						endedAt: at(2),
					},
				},
			},
		});
		const html = render(h, "decisions");
		expect(html).toContain('data-testid="brain-stuck"');
		expect(html).toContain("3 failed turns");
		expect(html).toContain("no conversation found");
		expect(html).toContain("Retry");
	});

	test("a running turn does not offer retry", () => {
		const h = harness();
		seed(h, {
			session: {
				enabled: true,
				session: { ...SESSION.session, status: "turn" },
			},
		});
		const html = render(h, "decisions");
		expect(html).not.toContain("Retry");
		expect(html).toContain("brain turn running");
	});
});

describe("no brain configured", () => {
	test("a quiet hint, no tabs of data", () => {
		const h = harness();
		h.queryClient.setQueryData(
			h.trpc.brain.session.queryKey({ project: PROJECT }),
			{ enabled: false, session: null } as never,
		);
		const html = render(h, "decisions");
		expect(html).toContain("Brain: off");
		expect(html).toContain("brain.routes");
		expect(html).not.toContain('data-testid="decision-row"');
	});
});

describe("DecisionRow", () => {
	test("expanded shows alternatives and what it read", () => {
		const h = harness();
		const html = renderToString(
			wrap(
				h,
				<ul>
					<DecisionRow
						project={PROJECT}
						decision={decision() as never}
						defaultOpen
					/>
				</ul>,
			),
		);
		expect(html).toContain("one attempt");
		expect(html).toContain("design is open");
		expect(html).toContain("Read: 1 tasks");
		expect(html).toContain("second line of the rationale");
	});

	test("a rejection shows its code and fix", () => {
		const h = harness();
		const html = renderToString(
			wrap(
				h,
				<ul>
					<DecisionRow
						project={PROJECT}
						decision={
							decision({
								output: {
									status: "rejected",
									rejection: {
										code: "task_claimed",
										message: "T-1 has a live run",
										fix: { text: "Stop the run first" },
									},
								},
							}) as never
						}
						defaultOpen
					/>
				</ul>,
			),
		);
		expect(html).toContain("task_claimed");
		expect(html).toContain("Stop the run first");
		expect(html).not.toContain("shadow: proposed");
	});
});
