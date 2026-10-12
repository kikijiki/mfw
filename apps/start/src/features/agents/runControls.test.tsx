import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { AppRouter } from "@mfw/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, type TRPCLink } from "@trpc/client";
import { observable } from "@trpc/server/observable";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { ToastProvider } from "../../lib/toast";
import { TRPCProvider } from "../../lib/trpc";
import type { TranscriptItem } from "../transcript/entries";
import {
	approvalSettled,
	markGroupWinner,
	markRunStopping,
	restoreRunSnapshot,
	runControlState,
	runMoves,
} from "./runControls";
import {
	type NodeActions,
	type NodeActionTarget,
	refusalText,
	useNodeActions,
} from "./useNodeActions";
import { type RunControls, useRunControls } from "./useRunControls";

const caps = {
	verified: true,
	steer: true,
	interrupt: true,
	approvals: true,
	plan: true,
	fileChanges: true,
	commandProgress: true,
	mcp: true,
};

function activeRow(project: string, runId: string) {
	return {
		project,
		runId,
		kind: "task" as const,
		state: "running" as const,
		label: runId,
		model: "m",
		providerId: null,
		reasoningEffort: null,
		taskId: null,
		taskTitle: null,
		attempt: 1,
		capabilities: caps,
		steerable: true,
		startedAt: 0,
		activity: null,
		activityDetail: null,
		scopeSample: null,
		liveCostUsd: null,
		route: null,
	};
}

type Op = { path: string; type: string; input: unknown };

/** A tRPC client whose every call is recorded and answered `{ ok: true }`, or failed. */
function harness(opts: { fail?: boolean } = {}) {
	const ops: Op[] = [];
	const link: TRPCLink<AppRouter> =
		() =>
		({ op }) =>
			observable((observer) => {
				ops.push({ path: op.path, type: op.type, input: op.input });
				if (opts.fail) observer.error(new Error("refused") as never);
				else {
					observer.next({ result: { type: "data", data: { ok: true } } });
					observer.complete();
				}
			});
	const client = createTRPCClient<AppRouter>({ links: [link] });
	const queryClient = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const trpc = createTRPCOptionsProxy<AppRouter>({ client, queryClient });
	return { ops, client, queryClient, trpc };
}

/** Render the hook once (SSR: no effects) and hand back what it returned. */
function mount(h: ReturnType<typeof harness>, state = "running") {
	let controls: RunControls | null = null;
	function Probe() {
		controls = useRunControls({
			project: "alpha",
			runId: "01RUN",
			label: "MFW-1",
			state,
			capabilities: caps,
		});
		return null;
	}
	renderToString(
		createElement(
			ToastProvider,
			null,
			createElement(
				QueryClientProvider,
				{ client: h.queryClient },
				createElement(TRPCProvider, {
					trpcClient: h.client,
					queryClient: h.queryClient,
					// biome-ignore lint/correctness/noChildrenProp: createElement(TRPCProvider, props) needs children inside props to typecheck
					children: createElement(Probe),
				}),
			),
		),
	);
	if (!controls) throw new Error("hook did not render");
	return controls as RunControls;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

/** Render `useNodeActions` once for any node kind. */
function mountNode(h: ReturnType<typeof harness>, target: NodeActionTarget) {
	let actions: NodeActions | null = null;
	function Probe() {
		actions = useNodeActions(target);
		return null;
	}
	renderToString(
		createElement(
			ToastProvider,
			null,
			createElement(
				QueryClientProvider,
				{ client: h.queryClient },
				createElement(TRPCProvider, {
					trpcClient: h.client,
					queryClient: h.queryClient,
					// biome-ignore lint/correctness/noChildrenProp: createElement(TRPCProvider, props) needs children inside props to typecheck
					children: createElement(Probe),
				}),
			),
		),
	);
	if (!actions) throw new Error("hook did not render");
	return actions as NodeActions;
}

const runTarget = (state = "running"): NodeActionTarget => ({
	kind: "run",
	project: "alpha",
	runId: "01RUN",
	label: "MFW-1",
	state,
	capabilities: caps,
});

const groupView = (over: Record<string, unknown> = {}) => ({
	id: "G1",
	taskId: "MFW-1",
	kind: "competing",
	selection: "brain",
	status: "open",
	winnerRunId: null,
	createdBy: "decision:7",
	createdAt: new Date(0),
	closedAt: null,
	selectedBy: null,
	attempts: [
		{ runId: "A1", winner: false },
		{ runId: "A2", winner: false },
	],
	...over,
});

const flowWith = () => ({
	seq: 1,
	nodes: [
		{
			ref: "group:G1",
			parent: "task:MFW-1",
			kind: "group",
			title: "2 competing attempts",
			needsMe: null,
			lastAt: new Date(0),
			group: { status: "open", winner: null, selection: "brain" },
		},
		{
			ref: "run:A1",
			parent: "group:G1",
			kind: "run",
			title: "A1",
			needsMe: null,
			lastAt: new Date(0),
			run: { attempt: { groupRef: "group:G1", winner: false } },
		},
		{
			ref: "run:A2",
			parent: "group:G1",
			kind: "run",
			title: "A2",
			needsMe: null,
			lastAt: new Date(0),
			run: { attempt: { groupRef: "group:G1", winner: false } },
		},
	],
});

describe("runControlState mirrors the daemon's gates", () => {
	test("only a running, verified harness steers or answers approvals", () => {
		expect(runControlState({ state: "running", capabilities: caps })).toEqual({
			stoppable: true,
			steerable: true,
			approvals: true,
			gracefulStop: true,
		});
		const unverified = runControlState({
			state: "running",
			capabilities: { ...caps, verified: false },
		});
		expect(unverified.steerable).toBe(false);
		expect(unverified.approvals).toBe(false);
		expect(unverified.gracefulStop).toBe(false);
		expect(unverified.stoppable).toBe(true);
	});

	test("a run that is not running offers nothing to press", () => {
		for (const state of ["starting", "ended", "finalizing", "completed"]) {
			const s = runControlState({ state, capabilities: caps });
			expect([s.stoppable, s.steerable, s.approvals]).toEqual([
				false,
				false,
				false,
			]);
		}
		expect(
			runControlState({ state: "running", capabilities: null }).steerable,
		).toBe(false);
	});
});

describe("optimistic stop", () => {
	test("patches every cached view of the run and restores them exactly", () => {
		const { queryClient, trpc } = harness();
		const activeKey = trpc.runs.active.queryKey();
		const before = [activeRow("alpha", "01RUN"), activeRow("beta", "01RUN")];
		queryClient.setQueryData(activeKey, before);
		const getKey = trpc.runs.get.queryKey({ project: "alpha", runId: "01RUN" });
		queryClient.setQueryData(getKey, {
			id: "01RUN",
			state: "running",
		} as never);
		const listKey = trpc.runs.list.queryKey({
			project: "alpha",
			limit: 100,
			includeInternal: false,
		});
		queryClient.setQueryData(listKey, [
			{ id: "01RUN", state: "running" },
			{ id: "01OTHER", state: "running" },
		] as never);
		const allKey = trpc.runs.listAll.queryKey({ limit: 200 });
		queryClient.setQueryData(allKey, [
			{ project: "beta", id: "01RUN", state: "running" },
			{ project: "alpha", id: "01RUN", state: "running" },
		] as never);

		const snapshot = markRunStopping(queryClient, trpc, "alpha", "01RUN");

		const active = queryClient.getQueryData(activeKey);
		expect(active?.map((r) => [r.project, r.state, r.steerable])).toEqual([
			["alpha", "ended", false],
			// Same run id in another project is a different run.
			["beta", "running", true],
		]);
		expect(queryClient.getQueryData(getKey)?.state).toBe("ended");
		expect(
			(queryClient.getQueryData(listKey) as unknown as { state: string }[]).map(
				(r) => r.state,
			),
		).toEqual(["ended", "running"]);
		expect(
			(queryClient.getQueryData(allKey) as unknown as { state: string }[]).map(
				(r) => r.state,
			),
		).toEqual(["running", "ended"]);

		restoreRunSnapshot(queryClient, snapshot);
		expect(queryClient.getQueryData(activeKey) as unknown).toEqual(before);
		expect(
			(
				queryClient.getQueryData(getKey as never) as
					| { state?: string }
					| undefined
			)?.state,
		).toBe("running");
	});

	test("a run absent from the cache leaves nothing to restore", () => {
		const { queryClient, trpc } = harness();
		expect(markRunStopping(queryClient, trpc, "alpha", "01RUN")).toEqual([]);
	});
});

describe("useRunControls: the single action path", () => {
	test("stop sends exactly one runs.stop and patches the dock row", async () => {
		const h = harness();
		h.queryClient.setQueryData(h.trpc.runs.active.queryKey(), [
			activeRow("alpha", "01RUN"),
		]);
		const controls = mount(h);
		controls.stop.confirm();
		await settle();
		expect(h.ops).toEqual([
			{
				path: "runs.stop",
				type: "mutation",
				input: { project: "alpha", runId: "01RUN" },
			},
		]);
		// The live channel's run.state_changed (not this test) brings the truth back.
		const row = h.queryClient.getQueryData(h.trpc.runs.active.queryKey())?.[0];
		expect(row?.state).toBe("ended");
	});

	test("a refused stop rolls the dock row back", async () => {
		const h = harness({ fail: true });
		h.queryClient.setQueryData(h.trpc.runs.active.queryKey(), [
			activeRow("alpha", "01RUN"),
		]);
		mount(h).stop.confirm();
		await settle();
		const row = h.queryClient.getQueryData(h.trpc.runs.active.queryKey())?.[0];
		expect(row?.state).toBe("running");
	});

	test("steer trims, skips blanks, and approvals carry the request id", async () => {
		const h = harness();
		const controls = mount(h);
		controls.steer.send("   ");
		controls.steer.send("  use the fixture  ");
		controls.approval.respond("req-7", "decline");
		await settle();
		expect(h.ops.map((op) => [op.path, op.input])).toEqual([
			[
				"runs.steer",
				{ project: "alpha", runId: "01RUN", message: "use the fixture" },
			],
			[
				"runs.respondApproval",
				{
					project: "alpha",
					runId: "01RUN",
					requestId: "req-7",
					decision: "decline",
				},
			],
		]);
	});
});

describe("a server refusal reaches the person with its fix", () => {
	test("the fix text is appended to the message", () => {
		expect(
			refusalText({
				message: "A2 has not passed verification",
				data: {
					fix: {
						kind: "ui",
						text: "Only a run that settled verified can win.",
					},
				},
			}),
		).toBe(
			"A2 has not passed verification. Fix: Only a run that settled verified can win.",
		);
		expect(refusalText({ message: "boom", data: { fix: null } })).toBe("boom");
	});
});

describe("moves of a run", () => {
	test("pause needs a running run; resume and reroute also open on a settled one", () => {
		expect(runMoves("running")).toEqual({
			pause: true,
			resume: false,
			reroute: true,
		});
		expect(runMoves("failed")).toEqual({
			pause: false,
			resume: true,
			reroute: true,
		});
		expect(runMoves("completed")).toEqual({
			pause: false,
			resume: false,
			reroute: false,
		});
		expect(runMoves("starting").reroute).toBe(false);
	});
});

describe("useNodeActions: run moves", () => {
	test("pause is the one stop mutation (worktree kept), with the same optimistic patch", async () => {
		const h = harness();
		h.queryClient.setQueryData(h.trpc.runs.active.queryKey(), [
			activeRow("alpha", "01RUN"),
		]);
		mountNode(h, runTarget()).run.pause.send();
		await settle();
		expect(h.ops.map((o) => o.path)).toEqual(["runs.stop"]);
		expect(
			h.queryClient.getQueryData(h.trpc.runs.active.queryKey())?.[0]?.state,
		).toBe("ended");
	});

	test("resume asks the server to continue on the run's own route", async () => {
		const h = harness();
		mountNode(h, runTarget("failed")).run.resume.send();
		await settle();
		expect(h.ops).toEqual([
			{
				path: "runs.reroute",
				type: "mutation",
				input: { project: "alpha", runId: "01RUN", keepRoute: true },
			},
		]);
	});

	test("reroute sends the pick, and a refusal rolls the optimistic stop back", async () => {
		const h = harness({ fail: true });
		h.queryClient.setQueryData(h.trpc.runs.active.queryKey(), [
			activeRow("alpha", "01RUN"),
		]);
		const actions = mountNode(h, runTarget());
		actions.run.reroute.send({ harness: "codex-cli", model: "gpt-5.6" });
		await settle();
		expect(h.ops).toEqual([
			{
				path: "runs.reroute",
				type: "mutation",
				input: {
					project: "alpha",
					runId: "01RUN",
					harness: "codex-cli",
					model: "gpt-5.6",
				},
			},
		]);
		expect(
			h.queryClient.getQueryData(h.trpc.runs.active.queryKey())?.[0]?.state,
		).toBe("running");
	});

	test("an accepted reroute keeps the optimistic patch until the live channel replaces it", async () => {
		const h = harness();
		h.queryClient.setQueryData(h.trpc.runs.active.queryKey(), [
			activeRow("alpha", "01RUN"),
		]);
		mountNode(h, runTarget()).run.reroute.send({ model: "opus" });
		await settle();
		expect(
			h.queryClient.getQueryData(h.trpc.runs.active.queryKey())?.[0]?.state,
		).toBe("ended");
	});

	test("answer sends one answer to the run's question and resumes", async () => {
		const h = harness();
		mountNode(h, runTarget()).run.answer.send("  migrate  ");
		mountNode(h, runTarget()).run.answer.send("   ");
		await settle();
		expect(h.ops).toEqual([
			{
				path: "clarify.answer",
				type: "mutation",
				input: {
					project: "alpha",
					runId: "01RUN",
					answers: [{ index: 0, answer: "migrate" }],
					continuePlanning: true,
				},
			},
		]);
	});
});

describe("useNodeActions: group and task", () => {
	const groupTarget = (live: string[] = ["A1", "A2"]): NodeActionTarget => ({
		kind: "group",
		project: "alpha",
		groupId: "G1",
		taskId: "MFW-1",
		liveRunIds: live,
	});

	test("select winner stars the attempt at once in the group and the Flow caches", async () => {
		const h = harness();
		h.queryClient.setQueryData(
			h.trpc.groups.get.queryKey({ project: "alpha", groupId: "G1" }),
			groupView() as never,
		);
		h.queryClient.setQueryData(
			h.trpc.flow.tree.queryKey({ project: "alpha" }),
			flowWith() as never,
		);
		mountNode(h, groupTarget()).group.selectWinner.send("A2", "cleaner");
		await settle();
		expect(h.ops).toEqual([
			{
				path: "groups.selectWinner",
				type: "mutation",
				input: {
					project: "alpha",
					groupId: "G1",
					runId: "A2",
					reason: "cleaner",
				},
			},
		]);
		const view = h.queryClient.getQueryData(
			h.trpc.groups.get.queryKey({ project: "alpha", groupId: "G1" }),
		);
		expect(view).toMatchObject({ status: "selecting", winnerRunId: "A2" });
		const nodes = (
			h.queryClient.getQueryData(
				h.trpc.flow.tree.queryKey({ project: "alpha" }),
			) as ReturnType<typeof flowWith>
		).nodes as unknown as {
			ref: string;
			group?: { status: string; winner: string | null };
			run?: { attempt: { winner: boolean } };
		}[];
		expect(nodes.find((n) => n.ref === "group:G1")?.group).toMatchObject({
			status: "selecting",
			winner: "run:A2",
		});
		expect(nodes.find((n) => n.ref === "run:A2")?.run?.attempt.winner).toBe(
			true,
		);
		expect(nodes.find((n) => n.ref === "run:A1")?.run?.attempt.winner).toBe(
			false,
		);
	});

	test("a refused selection restores the group and the Flow nodes", async () => {
		const h = harness({ fail: true });
		const groupKey = h.trpc.groups.get.queryKey({
			project: "alpha",
			groupId: "G1",
		});
		const flowKey = h.trpc.flow.tree.queryKey({ project: "alpha" });
		h.queryClient.setQueryData(groupKey, groupView() as never);
		h.queryClient.setQueryData(flowKey, flowWith() as never);
		mountNode(h, groupTarget()).group.selectWinner.send("A2");
		await settle();
		expect(h.queryClient.getQueryData(groupKey)).toMatchObject({
			status: "open",
			winnerRunId: null,
		});
		const nodes = (
			h.queryClient.getQueryData(flowKey) as ReturnType<typeof flowWith>
		).nodes as unknown as {
			ref: string;
			group?: { status: string };
		}[];
		expect(nodes.find((n) => n.ref === "group:G1")?.group?.status).toBe("open");
	});

	test("markGroupWinner snapshots every cache it touched and leaves unrelated ones alone", () => {
		const h = harness();
		const groupKey = h.trpc.groups.get.queryKey({
			project: "alpha",
			groupId: "G1",
		});
		const other = h.trpc.groups.get.queryKey({
			project: "alpha",
			groupId: "G2",
		});
		h.queryClient.setQueryData(groupKey, groupView() as never);
		h.queryClient.setQueryData(other, groupView({ id: "G2" }) as never);
		const snapshot = markGroupWinner(
			h.queryClient,
			h.trpc,
			"alpha",
			"G1",
			"A1",
		);
		expect(snapshot).toHaveLength(1);
		expect(h.queryClient.getQueryData(other)).toMatchObject({
			status: "open",
		});
		restoreRunSnapshot(h.queryClient, snapshot);
		expect(h.queryClient.getQueryData(groupKey)).toMatchObject({
			status: "open",
		});
	});

	test("stop all stops every live attempt, one runs.stop each", async () => {
		const h = harness();
		h.queryClient.setQueryData(h.trpc.runs.active.queryKey(), [
			activeRow("alpha", "A1"),
			activeRow("alpha", "A2"),
		]);
		const actions = mountNode(h, groupTarget());
		expect(actions.group.stopAll.count).toBe(2);
		actions.group.stopAll.confirm();
		await settle();
		expect(h.ops.map((o) => [o.path, o.input])).toEqual([
			["runs.stop", { project: "alpha", runId: "A1" }],
			["runs.stop", { project: "alpha", runId: "A2" }],
		]);
		const rows = h.queryClient.getQueryData(h.trpc.runs.active.queryKey());
		expect(rows?.map((r) => r.state)).toEqual(["ended", "ended"]);
	});

	test("add attempt sends the pick to the group", async () => {
		const h = harness();
		mountNode(h, groupTarget()).group.addAttempt.send({
			harness: "codex-cli",
			model: "gpt-5.6",
		});
		await settle();
		expect(h.ops).toEqual([
			{
				path: "groups.addAttempt",
				type: "mutation",
				input: {
					project: "alpha",
					groupId: "G1",
					harness: "codex-cli",
					model: "gpt-5.6",
				},
			},
		]);
	});

	test("a task pauses and resumes through the hold store, by its own id", async () => {
		const h = harness();
		const actions = mountNode(h, {
			kind: "task",
			project: "alpha",
			taskId: "MFW-9",
			liveRunIds: [],
		});
		actions.task.pause.send("waiting for design");
		actions.task.resume.send();
		await settle();
		expect(h.ops.map((o) => [o.path, o.input])).toEqual([
			[
				"holds.pause",
				{ project: "alpha", taskIds: ["MFW-9"], reason: "waiting for design" },
			],
			["holds.resume", { project: "alpha", taskIds: ["MFW-9"] }],
		]);
	});
});

describe("approval in flight", () => {
	const approval = (status: string) =>
		({
			kind: "approval",
			seq: 1,
			requestId: "req-1",
			approvalKind: "command",
			status,
			summary: "run rm",
		}) as unknown as TranscriptItem;

	test("stays in flight until the transcript shows it resolved", () => {
		expect(approvalSettled([approval("pending")], "req-1")).toBe(false);
		expect(approvalSettled([], "req-1")).toBe(false);
		expect(approvalSettled([approval("accepted")], "req-1")).toBe(true);
		expect(approvalSettled([approval("declined")], "req-2")).toBe(false);
	});
});

/**
 * One stop path: nothing outside the hook builds its own stop, steer or
 * approval mutation. A screen that does has its own rollback and its own
 * wording, which is how NOW and the run page drifted apart.
 */
describe("no screen owns a run mutation", () => {
	const root = join(import.meta.dir, "..", "..");
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
				files.push(path);
		}
	};
	walk(root);

	test.each([
		"runs.stop.mutationOptions",
		"runs.steer.mutationOptions",
		"runs.respondApproval.mutationOptions",
		"runs.reroute.mutationOptions",
		"clarify.answer.mutationOptions",
		"groups.selectWinner.mutationOptions",
		"groups.addAttempt.mutationOptions",
		"holds.pause.mutationOptions",
		"holds.resume.mutationOptions",
	])("%s appears only in useNodeActions", (needle) => {
		const owners = files
			.filter((f) => readFileSync(f, "utf8").includes(needle))
			.map((f) => relative(root, f));
		// The clarify dialog answers a whole set (several questions, a re-plan); a run's single answer is built here.
		expect(
			owners.filter((o) => o !== "features/clarify/ClarifyDialog.tsx"),
		).toEqual(["features/agents/useNodeActions.tsx"]);
	});
});
