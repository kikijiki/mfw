import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { appendEvent } from "@mfw/db/eventlog";
import {
	decisions,
	type RunKind,
	type RunRelation,
	type RunState,
	reviewVerdicts,
	runs,
} from "@mfw/db/schema";
import { createCaller } from "../src/root.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
	for (const c of cleanups) await c();
});

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const DAY = 86_400_000;

interface TaskSeed {
	id: string;
	title?: string;
	status?: string;
	parentId?: string | null;
	type?: string;
	updatedAt?: number;
}
type RunInsert = typeof runs.$inferInsert;

function run(
	id: string,
	taskId: string | null,
	over: Partial<RunInsert> & { ago?: number; took?: number } = {},
): RunInsert {
	const { ago = 0, took, ...rest } = over;
	const startedAt = NOW - ago;
	const state: RunState = (rest.state as RunState | undefined) ?? "completed";
	return {
		id,
		kind: "task" as RunKind,
		taskId,
		label: id,
		model: "sonnet",
		cwd: "/w",
		state,
		startedAt: new Date(startedAt),
		finishedAt:
			state === "running" || state === "starting"
				? null
				: new Date(startedAt + (took ?? 1000)),
		relation: "fresh" as RunRelation,
		...rest,
	};
}

async function fixture(
	tasks: TaskSeed[],
	rows: RunInsert[],
): Promise<{
	api: ReturnType<typeof createCaller>;
	handle: ProjectDbHandle;
	nativeRun?: string;
}> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-flow-"));
	const handle = await openProjectDb(dir);
	cleanups.push(async () => {
		handle.close();
		await rm(dir, { recursive: true, force: true });
	});
	for (let i = 0; i < rows.length; i += 200)
		await handle.db.insert(runs).values(rows.slice(i, i + 200));
	const taskRows = tasks.map((t) => ({
		id: t.id,
		title: t.title ?? t.id,
		status: t.status ?? "in_progress",
		type: t.type ?? "feature",
		parentId: t.parentId ?? null,
		updatedAt: new Date(t.updatedAt ?? NOW - 100 * DAY),
	}));
	const svc = {
		name: "demo",
		handle,
		tasks: {
			list: async () => taskRows,
			get: async (id: string) => taskRows.find((t) => t.id === id) ?? null,
		},
		registry: {
			get: async (id: string) => rows.find((r) => r.id === id) ?? null,
		},
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return { api: createCaller({ orchestrator }), handle };
}

/** A small board: an epic with two tasks, chains, a judge, a folded history. */
function board() {
	const tasks: TaskSeed[] = [
		{ id: "E-1", type: "epic" },
		{ id: "T-1", parentId: "E-1" },
		{ id: "T-2", parentId: "E-1", status: "blocked" },
		{ id: "T-3" },
		{ id: "T-9", status: "done", updatedAt: NOW - 60 * DAY },
	];
	const rows: RunInsert[] = [
		run("r1", "T-1", { ago: 3 * 3600_000 }),
		run("r1a", "T-1", {
			ago: 2 * 3600_000,
			parentRunId: "r1",
			relation: "repair",
			label: "T-1#repair",
		}),
		run("r1b", "T-1", {
			ago: 1 * 3600_000,
			parentRunId: "r1a",
			relation: "resume",
			label: "T-1#resume",
			state: "running",
			activity: "needs_answer",
		}),
		run("j1", "T-1", {
			ago: 2 * 3600_000,
			kind: "brain",
			parentRunId: "r1",
			relation: "judge",
			label: "critic:r1",
		}),
		// T-2: one old run (folded) and one live
		run("old2", "T-2", { ago: 20 * DAY }),
		run("live2", "T-2", {
			ago: 600_000,
			state: "running",
			activity: "working",
		}),
		// a plan run with no task
		run("p1", null, { kind: "plan", label: "plan", ago: 5 * 3600_000 }),
		// a re-plan under it
		run("p2", null, {
			kind: "plan",
			label: "plan#replan",
			relation: "replan",
			parentRunId: "p1",
			ago: 4 * 3600_000,
		}),
		// T-9 is done long ago: rollup only
		run("old9", "T-9", { ago: 60 * DAY }),
	];
	return { tasks, rows };
}

describe("flow.tree", () => {
	test("parent refs form a forest rooted at top-level nodes", async () => {
		const { tasks, rows } = board();
		const { api } = await fixture(tasks, rows);
		const tree = await api.flow.tree({ project: "demo" });
		const refs = new Set(tree.nodes.map((n) => n.ref));
		expect(refs.size).toBe(tree.nodes.length); // refs are unique
		for (const n of tree.nodes) {
			if (n.parent !== null) expect(refs.has(n.parent)).toBe(true);
			// walking up always terminates at a root (no cycles)
			const seen = new Set<string>();
			let cur: typeof n | undefined = n;
			while (cur?.parent) {
				expect(seen.has(cur.ref)).toBe(false);
				seen.add(cur.ref);
				cur = tree.nodes.find((x) => x.ref === cur?.parent);
			}
		}
		const by = new Map(tree.nodes.map((n) => [n.ref, n]));
		expect(by.get("task:T-1")?.parent).toBe("task:E-1");
		expect(by.get("task:E-1")?.parent).toBeNull();
		expect(by.get("task:E-1")?.kind).toBe("epic");
		expect(by.get("run:r1")?.parent).toBe("task:T-1");
		expect(by.get("run:r1a")?.parent).toBe("run:r1");
		expect(by.get("run:r1b")?.parent).toBe("run:r1a");
		expect(by.get("run:r1b")?.run?.continues).toBe("run:r1a");
		expect(by.get("run:j1")?.kind).toBe("judge");
		expect(by.get("run:j1")?.parent).toBe("run:r1");
		expect(by.get("run:p2")?.parent).toBe("run:p1");
		expect(by.get("run:p1")?.parent).toBeNull();
		expect(typeof tree.seq).toBe("number");
	});

	test("ended runs older than since fold into one group per task; done tasks keep a rollup only", async () => {
		const { tasks, rows } = board();
		const { api } = await fixture(tasks, rows);
		const tree = await api.flow.tree({
			project: "demo",
			since: new Date(NOW - 7 * DAY),
		});
		const refs = tree.nodes.map((n) => n.ref);
		expect(refs).not.toContain("run:old2");
		const group = tree.nodes.find((n) => n.ref === "group:ended:T-2");
		expect(group).toMatchObject({
			kind: "group",
			parent: "task:T-2",
			rollup: { total: 1 },
		});
		expect(refs).toContain("run:live2");
		// T-9 idle for 60 days: no run nodes, but its rollup counts its run
		expect(refs).not.toContain("run:old9");
		expect(refs).not.toContain("group:ended:T-9");
		expect(tree.nodes.find((n) => n.ref === "task:T-9")?.rollup).toMatchObject({
			total: 1,
			done: 1,
			live: 0,
		});

		const all = await api.flow.tree({
			project: "demo",
			include: { ended: "all" },
		});
		expect(all.nodes.map((n) => n.ref)).toContain("run:old2");
	});

	test("rollups match a brute-force count over the subtree", async () => {
		const { tasks, rows } = board();
		const { api } = await fixture(tasks, rows);
		const tree = await api.flow.tree({ project: "demo" });
		const parentOf = new Map(tasks.map((t) => [t.id, t.parentId ?? null]));
		const under = (id: string, root: string): boolean => {
			for (let cur: string | null = id; cur; cur = parentOf.get(cur) ?? null)
				if (cur === root) return true;
			return false;
		};
		for (const t of tasks) {
			const mine = rows.filter((r) => r.taskId && under(r.taskId, t.id));
			const live = mine.filter((r) => r.state === "running");
			const needs = live.filter((r) =>
				["needs_answer", "awaiting_approval", "stalled"].includes(
					r.activity ?? "",
				),
			);
			expect(tree.nodes.find((n) => n.ref === `task:${t.id}`)?.rollup).toEqual({
				total: mine.length,
				done: mine.length - live.length,
				live: live.length,
				needsMe: needs.length,
				costUsdToday: 0,
			});
		}
		const t1 = tree.nodes.find((n) => n.ref === "run:r1b");
		expect(t1?.needsMe).toBe("question");
		expect(tree.nodes.find((n) => n.ref === "task:T-2")?.needsMe).toBe("inbox");
	});

	test("a live run carries the sampled cost; a settled one does not", async () => {
		const { api } = await fixture(
			[{ id: "T-1" }],
			[
				run("live", "T-1", {
					state: "running",
					usageLive: { inputTokens: 10, outputTokens: 2, costUsd: 0.42 },
				}),
				run("done", "T-1", {
					usageLive: { inputTokens: 10, outputTokens: 2, costUsd: 0.1 },
					usage: { costUsd: 0.12 },
				}),
			],
		);
		const tree = await api.flow.tree({ project: "demo" });
		const by = new Map(tree.nodes.map((n) => [n.ref, n]));
		expect(by.get("run:live")?.run?.liveCostUsd).toBe(0.42);
		expect(by.get("run:done")?.run?.liveCostUsd).toBeNull();
		expect(by.get("run:done")?.run?.costUsd).toBe(0.12);
	});

	test("history pips ride on task nodes", async () => {
		const { tasks, rows } = board();
		const { api } = await fixture(tasks, rows);
		const tree = await api.flow.tree({ project: "demo" });
		const t1 = tree.nodes.find((n) => n.ref === "task:T-1");
		expect(t1?.historyPips?.map((p) => p.ref)).toEqual(["run:r1", "run:r1a"]);
	});

	test("perf: 900 tasks and 3,000 runs under 300 ms", async () => {
		const tasks: TaskSeed[] = [];
		const rows: RunInsert[] = [];
		for (let i = 0; i < 900; i++) {
			tasks.push({
				id: `P-${i}`,
				parentId: i % 10 === 0 || i === 0 ? null : `P-${i - (i % 10)}`,
				status: i % 3 === 0 ? "done" : "in_progress",
				updatedAt: NOW - (i % 40) * DAY,
			});
		}
		for (let i = 0; i < 3000; i++) {
			rows.push(
				run(`R-${i}`, `P-${i % 900}`, {
					ago: (i % 30) * DAY,
					parentRunId: i >= 900 ? `R-${i - 900}` : null,
					relation: i >= 900 ? "repair" : "fresh",
				}),
			);
		}
		const { api } = await fixture(tasks, rows);
		await api.flow.tree({ project: "demo" }); // warm
		const t0 = performance.now();
		const tree = await api.flow.tree({ project: "demo" });
		const ms = performance.now() - t0;
		expect(tree.nodes.length).toBeGreaterThan(900);
		expect(ms).toBeLessThan(300);
	}, 60_000);
});

describe("flow.live", () => {
	test("returns live runs with their ancestors, in the same node shape as flow.tree", async () => {
		const { tasks, rows } = board();
		const { api } = await fixture(tasks, rows);
		const live = await api.flow.live({ project: "demo" });
		const tree = await api.flow.tree({ project: "demo" });
		const refs = live.nodes.map((n) => n.ref);
		// the live chain tip, its chain parents, its task and epic give it position
		expect(refs).toContain("run:r1b");
		expect(refs).toContain("run:r1a");
		expect(refs).toContain("run:r1");
		expect(refs).toContain("task:T-1");
		expect(refs).toContain("task:E-1");
		expect(refs).toContain("run:live2");
		// nothing that is neither live nor an ancestor of live work
		expect(refs).not.toContain("task:T-9");
		expect(refs).not.toContain("run:old2");
		for (const n of live.nodes) {
			if (n.parent !== null) expect(refs).toContain(n.parent);
			// identical to the project tree's node for the same ref
			expect(n).toEqual(tree.nodes.find((x) => x.ref === n.ref) as typeof n);
		}
	});
});

describe("flow.spans", () => {
	test("returns spans overlapping the window for the subtree, and markers from existing tables", async () => {
		const { tasks, rows } = board();
		const { api, handle } = await fixture(tasks, rows);
		const at = (ms: number) => NOW - 4 * 3600_000 + ms;
		await handle.withTx(async (tx) => {
			await appendEvent(
				tx,
				{
					type: "task.status_changed",
					taskId: "T-1",
					payload: { from: "ready", to: "in_progress", actor: "scheduler" },
				},
				at(0),
			);
			await appendEvent(
				tx,
				{
					type: "run.started",
					runId: "r1",
					taskId: "T-1",
					payload: { kind: "task", model: "m" },
				},
				at(1000),
			);
			await appendEvent(
				tx,
				{
					type: "run.activity_changed",
					runId: "r1",
					taskId: "T-1",
					payload: { from: null, to: "needs_answer", question: "q?" },
				},
				at(60_000),
			);
			await appendEvent(
				tx,
				{
					type: "run.state_changed",
					runId: "r1",
					taskId: "T-1",
					payload: { from: "running", to: "completed" },
				},
				at(120_000),
			);
			// another task's run, outside the subtree
			await appendEvent(
				tx,
				{
					type: "run.started",
					runId: "live2",
					taskId: "T-2",
					payload: { kind: "task", model: "m" },
				},
				at(2000),
			);
			await appendEvent(
				tx,
				{
					type: "verify.check",
					taskId: "T-1",
					runId: "r1",
					payload: { check: "run: bun test", passed: false },
				},
				at(100_000),
			);
			await appendEvent(
				tx,
				{
					type: "merge.completed",
					taskId: "T-1",
					runId: "r1",
					payload: { sha: "abc", target: "main" },
				},
				at(130_000),
			);
		});
		await handle.db.insert(decisions).values({
			ts: new Date(at(110_000)),
			role: "critic",
			taskId: "T-1",
			subjectRunId: "r1",
			model: "m",
			status: "ok",
			action: "accepted",
		});
		await handle.db.insert(reviewVerdicts).values({
			id: "V1",
			taskId: "T-1",
			subjectRunId: "r1",
			mode: "critic",
			verdict: "merge",
			createdAt: new Date(at(115_000)),
		});

		const from = new Date(at(-1000));
		const to = new Date(at(200_000));
		const res = await api.flow.spans({
			project: "demo",
			from,
			to,
			subtree: "task:T-1",
		});
		const subjects = new Set(res.spans.map((s) => s.subject));
		expect(subjects.has("run:r1")).toBe(true);
		expect(subjects.has("task:T-1")).toBe(true);
		expect(subjects.has("run:live2")).toBe(false);
		const asked = res.spans.find((s) => s.value === "needs_answer");
		expect(asked).toMatchObject({
			subject: "run:r1",
			lane: "activity",
			detail: { question: "q?" },
		});
		expect(asked?.end?.getTime()).toBe(at(120_000));
		expect(res.markers.map((m) => m.kind).sort()).toEqual([
			"decision",
			"merge",
			"verdict",
			"verify_fail",
		]);
		expect(res.markers.every((m) => m.subject === "run:r1")).toBe(true);

		// the whole project sees live2 too; a window after everything sees only open spans
		const whole = await api.flow.spans({ project: "demo", from, to });
		expect(new Set(whole.spans.map((s) => s.subject)).has("run:live2")).toBe(
			true,
		);
		const later = await api.flow.spans({
			project: "demo",
			from: new Date(at(10 * 3600_000)),
			to: new Date(at(11 * 3600_000)),
		});
		for (const s of later.spans) expect(s.end).toBeNull();
		expect(later.markers).toEqual([]);
		// a window before everything is empty
		const earlier = await api.flow.spans({
			project: "demo",
			from: new Date(at(-3600_000)),
			to: new Date(at(-1800_000)),
		});
		expect(earlier.spans).toEqual([]);
	});
});

describe("node.get and run detail", () => {
	test("node.get returns the node with its task, run or decision detail", async () => {
		const { tasks, rows } = board();
		const { api, handle } = await fixture(tasks, rows);
		await handle.db.insert(decisions).values({
			ts: new Date(NOW),
			role: "critic",
			taskId: "T-1",
			subjectRunId: "r1",
			model: "m",
			status: "ok",
			action: "accepted",
		});
		const task = await api.node.get({ project: "demo", ref: "task:T-1" });
		expect(task).toMatchObject({
			ref: "task:T-1",
			kind: "task",
			detail: { id: "T-1" },
		});
		const r = await api.node.get({ project: "demo", ref: "run:r1a" });
		expect(r).toMatchObject({
			ref: "run:r1a",
			parent: "run:r1",
			run: { relation: "repair" },
			detail: { id: "r1a" },
		});
		const d = await api.node.get({ project: "demo", ref: "decision:1" });
		expect(d).toMatchObject({
			kind: "decision",
			parent: "run:r1",
			detail: { id: 1, role: "critic" },
		});
		await expect(
			api.node.get({ project: "demo", ref: "run:nope" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		await expect(
			api.node.get({ project: "demo", ref: "bogus" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("flow.at", () => {
	const T0 = NOW - 3 * 3600_000;
	const m = (n: number) => T0 + n * 60_000;

	async function scrubFixture() {
		const tasks: TaskSeed[] = [{ id: "T-1", status: "review" }, { id: "T-2" }];
		const rows = [
			run("rX", "T-1", { ago: NOW - m(1), took: 7 * 60_000 }),
			run("rY", "T-1", {
				ago: NOW - m(20),
				state: "running",
				activity: "working",
			}),
		];
		const f = await fixture(tasks, rows);
		await f.handle.withTx(async (tx) => {
			const ev = (e: Parameters<typeof appendEvent>[1], ts: number) =>
				appendEvent(tx, e, ts);
			await ev(
				{
					type: "task.status_changed",
					taskId: "T-1",
					payload: { from: "ready", to: "in_progress", actor: "scheduler" },
				},
				m(0),
			);
			await ev(
				{
					type: "run.started",
					runId: "rX",
					taskId: "T-1",
					payload: { kind: "task", model: "m" },
				},
				m(1),
			);
			await ev(
				{
					type: "run.state_changed",
					runId: "rX",
					taskId: "T-1",
					payload: { from: "starting", to: "running" },
				},
				m(1) + 5000,
			);
			await ev(
				{
					type: "run.activity_changed",
					runId: "rX",
					taskId: "T-1",
					payload: { from: null, to: "needs_answer", question: "which?" },
				},
				m(2),
			);
			await ev(
				{
					type: "run.activity_changed",
					runId: "rX",
					taskId: "T-1",
					payload: { from: "needs_answer", to: "working" },
				},
				m(5),
			);
			await ev(
				{
					type: "run.state_changed",
					runId: "rX",
					taskId: "T-1",
					payload: { from: "running", to: "completed" },
				},
				m(8),
			);
			await ev(
				{
					type: "task.status_changed",
					taskId: "T-1",
					payload: { from: "in_progress", to: "review", actor: "scheduler" },
				},
				m(10),
			);
			await ev(
				{
					type: "run.started",
					runId: "rY",
					taskId: "T-1",
					payload: { kind: "task", model: "m" },
				},
				m(20),
			);
		});
		return f;
	}
	// biome-ignore lint/suspicious/noExplicitAny: test helper over a loose node shape
	type Loose = Record<string, any>;
	const node = (tree: { nodes: { ref: string }[] }, ref: string) =>
		tree.nodes.find((n) => n.ref === ref) as Loose | undefined;

	test("inside a needs_answer span the tree shows that activity, and the task status is the span open at t", async () => {
		const { api } = await scrubFixture();
		const at = await api.flow.at({ project: "demo", t: new Date(m(3)) });
		expect(node(at, "run:rX")).toMatchObject({
			needsMe: "question",
			run: { state: "running", activity: "needs_answer", finishedAt: null },
		});
		expect(node(at, "task:T-1")).toMatchObject({
			status: { value: "in_progress" },
			rollup: { total: 1, live: 1, needsMe: 1 },
		});
		// the future has not happened yet
		expect(node(at, "run:rY")).toBeUndefined();
		// the live tree, for contrast, has moved on
		const live = await api.flow.tree({ project: "demo" });
		expect(node(live, "task:T-1")?.status.value).toBe("review");
		expect(node(live, "run:rX")?.run.state).toBe("completed");
	});

	test("after the answer and the finish: working then completed, with a pip", async () => {
		const { api } = await scrubFixture();
		const mid = await api.flow.at({ project: "demo", t: new Date(m(6)) });
		expect(node(mid, "run:rX")?.run.activity).toBe("working");
		expect(node(mid, "run:rX")?.needsMe).toBeNull();
		const done = await api.flow.at({ project: "demo", t: new Date(m(9)) });
		expect(node(done, "run:rX")?.run).toMatchObject({
			state: "completed",
			activity: null,
		});
		expect(node(done, "task:T-1")?.historyPips).toEqual([
			{ ref: "run:rX", glyph: "ok" },
		]);
		const review = await api.flow.at({ project: "demo", t: new Date(m(11)) });
		expect(node(review, "task:T-1")?.status.value).toBe("review");
		expect(node(review, "task:T-1")?.needsMe).toBe("inbox");
		const later = await api.flow.at({ project: "demo", t: new Date(m(21)) });
		expect(node(later, "run:rY")).toBeDefined();
	});

	test("before the first recorded change the task shows the status it had; seq is the newest event at t", async () => {
		const { api, handle } = await scrubFixture();
		const early = await api.flow.at({ project: "demo", t: new Date(m(-5)) });
		expect(node(early, "task:T-1")?.status.value).toBe("ready");
		expect(early.nodes.some((n) => n.ref.startsWith("run:"))).toBe(false);
		const res = await handle.client.execute({
			sql: "SELECT MAX(seq) AS s FROM events WHERE ts <= ?",
			args: [m(6)],
		});
		const at6 = await api.flow.at({ project: "demo", t: new Date(m(6)) });
		expect(at6.seq).toBe(Number(res.rows[0]?.s));
		expect(at6.seq).toBeLessThan(
			(await api.flow.tree({ project: "demo" })).seq,
		);
	});

	test("t is quantised to the second, rounded up", async () => {
		const { api } = await scrubFixture();
		const res = await api.flow.at({ project: "demo", t: new Date(m(3) + 400) });
		expect(res.t.getTime()).toBe(m(3) + 1000);
	});
});
