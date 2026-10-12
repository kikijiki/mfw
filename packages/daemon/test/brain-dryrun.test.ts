import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	brainActions,
	decisions,
	events,
	mergeJobs,
	type RunKind,
} from "@mfw/db/schema";
import { and, eq, like, not } from "drizzle-orm";
import {
	type ActResult,
	BrainActionError,
} from "../src/brain-runtime/actions.ts";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

/**
 * `check()` is the act tools' validator without the recording: it answers
 * exactly what `act()` will answer and touches nothing (the board, the runs
 * and the claims stay byte-for-byte what they were). `act()` then runs the same
 * verdict live: spawns are accepted for the scheduler, the other tools apply
 * (the board tools write the board).
 */

let u: BrainUnit;
let turnRunId: string;
const ids: Record<string, string> = {};
const revs: Record<string, number> = {};

async function walk(dir: string, out: string[] = []): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return out;
	}
	for (const name of entries.sort()) {
		const path = join(dir, name);
		if ((await stat(path)).isDirectory()) await walk(path, out);
		else out.push(path);
	}
	return out;
}

/** A hash over everything an act tool could change: board files, claim sidecars, task rows, worker runs, merge jobs, non-brain events. */
async function snapshot(unit: BrainUnit): Promise<string> {
	const h = createHash("sha256");
	for (const dir of ["tasks", "state", "locks"]) {
		for (const file of await walk(join(unit.mfwDir, dir))) {
			h.update(file.slice(unit.mfwDir.length));
			h.update(await readFile(file));
		}
	}
	h.update(JSON.stringify(await unit.tasks.list()));
	h.update(
		JSON.stringify(
			(await unit.registry.list()).filter((r) => r.kind !== "brain"),
		),
	);
	h.update(JSON.stringify(await unit.handle.db.select().from(mergeJobs)));
	h.update(
		JSON.stringify(
			await unit.handle.db
				.select()
				.from(events)
				.where(not(like(events.type, "brain.%"))),
		),
	);
	return h.digest("hex");
}

async function workerRun(
	unit: BrainUnit,
	taskId: string | null,
	over: {
		state?: "running" | "completed";
		model?: string;
		kind?: RunKind;
		verified?: boolean;
		/** The deterministic checks ran and failed. */
		verifyFailed?: boolean;
		/** Make the run an attempt of this competing group. */
		group?: string;
	} = {},
) {
	if (over.group && taskId) {
		await unit.registry.ensureGroup({
			id: over.group,
			taskId,
			kind: "competing",
		});
	}
	const run = await unit.registry.create({
		kind: over.kind ?? "task",
		...(over.group ? { groupId: over.group, role: "attempt" as const } : {}),
		...(taskId ? { taskId } : {}),
		label: `${taskId ?? "x"}#w`,
		model: over.model ?? "sonnet",
		providerId: "claude-cli",
		harness: "claude-cli",
		cwd: unit.root,
		branch: `mfw/${taskId ?? "x"}-${Math.random().toString(36).slice(2, 8)}`,
	});
	await unit.registry.transition(run.id, "running", { from: "starting" });
	if (over.state === "completed") {
		await unit.registry.transition(run.id, "completed", {
			exitCode: 0,
			finishedAt: new Date(),
		});
	}
	if (over.verified || over.verifyFailed) {
		await unit.registry.beginStep(run.id, "verify");
		await unit.registry.finishStep(run.id, "verify", {
			passed: over.verifyFailed !== true,
			checks: [],
		});
	}
	return run.id;
}

beforeEach(async () => {
	u = await brainUnit({ maxConcurrent: 20 });
	// A: claimed by a live run. F: claimed too. B overlaps A. C is free.
	const a = await u.tasks.create({
		title: "A",
		status: "ready",
		owns: ["src/a/**"],
	});
	const f = await u.tasks.create({
		title: "F",
		status: "ready",
		owns: ["src/f/**"],
	});
	const b = await u.tasks.create({
		title: "B overlaps A",
		status: "ready",
		owns: ["src/a/x.ts"],
	});
	const c = await u.tasks.create({
		title: "C free",
		status: "ready",
		owns: ["src/c/**"],
	});
	const d = await u.tasks.create({
		title: "D waits on A",
		status: "backlog",
		dependsOn: [a.id],
	});
	Object.assign(ids, { a: a.id, f: f.id, b: b.id, c: c.id, d: d.id });
	const rA = await workerRun(u, a.id);
	const rF = await workerRun(u, f.id);
	await u.tasks.tryClaim(a.id, rA, 60_000);
	await u.tasks.tryClaim(f.id, rF, 60_000);
	revs.a = (await u.tasks.get(a.id))?.contentRev ?? 0;
	revs.c = (await u.tasks.get(c.id))?.contentRev ?? 0;
	ids.rA = rA;
	ids.rF = rF;
	ids.rVerified = await workerRun(u, c.id, {
		state: "completed",
		verified: true,
		group: "G-C",
	});
	ids.rDone = await workerRun(u, c.id, {
		state: "completed",
		verifyFailed: true,
		group: "G-C",
	});

	// A live turn to act in.
	await u.runtime.tick();
	await u.human("plan something");
	await u.runtime.tick();
	turnRunId = u.launched[0]?.runId ?? "";
	expect(turnRunId).not.toBe("");
});

afterEach(async () => {
	await u.cleanup();
});

const act = (tool: string, args: Record<string, unknown>) =>
	u.runtime.actions.act({ turnRunId, tool, args });

const why = { rationale: "because the frontier says so" };

describe("every act tool: one verdict from check() and act()", () => {
	type Case = {
		name: string;
		tool: string;
		args: () => Record<string, unknown>;
		expect: "proposed" | { rejected: string };
	};
	const cases: Case[] = [
		{
			name: "spawn a free ready task",
			tool: "spawn",
			args: () => ({ ...why, taskId: ids.c, role: "implement" }),
			expect: "proposed",
		},
		{
			name: "spawn a task whose owns overlaps a running claim",
			tool: "spawn",
			args: () => ({ ...why, taskId: ids.b, role: "implement" }),
			expect: { rejected: "owns_overlap" },
		},
		{
			name: "spawn a task with unfinished dependencies",
			tool: "spawn",
			args: () => ({ ...why, taskId: ids.d, role: "implement" }),
			expect: { rejected: "dependencies_open" },
		},
		{
			name: "spawn an unknown task",
			tool: "spawn",
			args: () => ({ ...why, taskId: "NOPE-1", role: "implement" }),
			expect: { rejected: "task_not_found" },
		},
		{
			name: "spawn without a rationale",
			tool: "spawn",
			args: () => ({ taskId: ids.c, role: "implement" }),
			expect: { rejected: "rationale_required" },
		},
		{
			name: "spawn with a typo in a field",
			tool: "spawn",
			args: () => ({ ...why, taskId: ids.c, role: "implement", modle: "x" }),
			expect: { rejected: "invalid_args" },
		},
		{
			name: "spawn_attempts that fit",
			tool: "spawn_attempts",
			args: () => ({
				...why,
				taskId: ids.c,
				variants: [{ model: "sonnet" }, { model: "opus" }],
				selection: "brain",
			}),
			expect: "proposed",
		},
		{
			name: "spawn_attempts past the group cap",
			tool: "spawn_attempts",
			args: () => ({
				...why,
				taskId: ids.c,
				variants: [{}, {}, {}, {}],
				selection: "brain",
			}),
			expect: { rejected: "attempt_cap" },
		},
		{
			name: "update_task with a stale rev",
			tool: "update_task",
			args: () => ({ ...why, id: ids.c, baseRev: 99, patch: { title: "x" } }),
			expect: { rejected: "stale_rev" },
		},
		{
			name: "update_task changing a claimed task's owns into another claim",
			tool: "update_task",
			args: () => ({
				...why,
				id: ids.a,
				baseRev: revs.a,
				patch: { owns: ["src/f/x.ts"] },
			}),
			expect: { rejected: "owns_overlap" },
		},
		{
			name: "update_task with a fresh rev",
			tool: "update_task",
			args: () => ({
				...why,
				id: ids.c,
				baseRev: revs.c,
				patch: { title: "C2" },
			}),
			expect: "proposed",
		},
		{
			name: "set_status on a task with a live run",
			tool: "set_status",
			args: () => ({ ...why, id: ids.a, to: "archived", reason: "dead" }),
			expect: { rejected: "task_claimed" },
		},
		{
			name: "set_status on an idle task",
			tool: "set_status",
			args: () => ({ ...why, id: ids.d, to: "blocked", reason: "needs A" }),
			expect: "proposed",
		},
		{
			name: "reparent under itself",
			tool: "reparent",
			args: () => ({ ...why, id: ids.c, parent: ids.c }),
			expect: { rejected: "hierarchy_cycle" },
		},
		{
			name: "steer a run that cannot be steered",
			tool: "steer",
			args: () => ({ ...why, runId: ids.rA, message: "hurry" }),
			expect: { rejected: "steer_unsupported" },
		},
		{
			name: "stop a live run",
			tool: "stop",
			args: () => ({ ...why, runId: ids.rA, reason: "wrong approach" }),
			expect: "proposed",
		},
		{
			name: "stop a finished run",
			tool: "stop",
			args: () => ({ ...why, runId: ids.rDone, reason: "again" }),
			expect: { rejected: "run_not_live" },
		},
		{
			name: "request_review by the same model",
			tool: "request_review",
			args: () => ({
				...why,
				runId: ids.rVerified,
				mode: "critic",
				reviewer: { harness: "claude-cli", model: "sonnet" },
			}),
			expect: { rejected: "reviewer_not_independent" },
		},
		{
			name: "request_review by an independent model",
			tool: "request_review",
			args: () => ({
				...why,
				runId: ids.rVerified,
				mode: "critic",
				reviewer: { harness: "codex-cli", model: "gpt-5" },
			}),
			expect: "proposed",
		},
		{
			name: "select_winner on an unverified run",
			tool: "select_winner",
			args: () => ({ ...why, runId: ids.rDone }),
			expect: { rejected: "not_verified" },
		},
		{
			name: "select_winner on a verified run",
			tool: "select_winner",
			args: () => ({ ...why, runId: ids.rVerified }),
			expect: "proposed",
		},
		{
			name: "answer_question with no open question",
			tool: "answer_question",
			args: () => ({ ...why, runId: ids.rA, answer: "yes" }),
			expect: { rejected: "no_open_question" },
		},
		{
			name: "create_tasks under an unknown parent",
			tool: "create_tasks",
			args: () => ({
				...why,
				tasks: [
					{ title: "n", type: "implementation", size: "s", parent: "X-9" },
				],
			}),
			expect: { rejected: "parent_not_found" },
		},
		{
			name: "create_tasks that is fine",
			tool: "create_tasks",
			args: () => ({
				...why,
				tasks: [
					{
						title: "n",
						type: "implementation",
						size: "s",
						depends_on: [ids.c],
						owns: ["src/n/**"],
					},
				],
			}),
			expect: "proposed",
		},
		{
			name: "pause an unknown task",
			tool: "pause",
			args: () => ({ ...why, taskIds: ["NOPE-1"] }),
			expect: { rejected: "task_not_found" },
		},
		{
			name: "notify_human",
			tool: "notify_human",
			args: () => ({
				...why,
				kind: "product_decision",
				title: "Pick a database",
				body: "two options",
				blocking: [ids.c],
			}),
			expect: "proposed",
		},
		{
			name: "set_budget has no ceiling to stay under yet",
			tool: "set_budget",
			args: () => ({ ...why, budget: "claude-cli", limitUsd: 5 }),
			expect: { rejected: "ceiling_unknown" },
		},
		{
			name: "sleep outside its bounds",
			tool: "sleep",
			args: () => ({ ...why, wakeAfterMin: 2 }),
			expect: { rejected: "invalid_args" },
		},
		{
			name: "sleep",
			tool: "sleep",
			args: () => ({ ...why, wakeAfterMin: 30 }),
			expect: "proposed",
		},
	];

	const BOARD = new Set([
		"create_tasks",
		"update_task",
		"reparent",
		"split_task",
		"merge_tasks",
		"set_status",
	]);

	for (const c of cases) {
		test(`${c.name}: check() is side-effect free and act() agrees`, async () => {
			const before = await snapshot(u);
			const live = await u.runtime.actions.check(c.tool, c.args());
			// The validator alone changes nothing.
			expect(await snapshot(u)).toBe(before);
			const workers = async () =>
				(await u.registry.list()).filter((x) => x.kind !== "brain").length;
			const workersBefore = await workers();
			const r = await act(c.tool, c.args());

			if (c.expect === "proposed") {
				expect(live.ok).toBe(true);
				if (BOARD.has(c.tool)) {
					// Board authority is live: the call applies and the board moved.
					expect(r.status).toBe("applied");
					expect(await snapshot(u)).not.toBe(before);
				} else if (c.tool === "spawn" || c.tool === "spawn_attempts") {
					// Accepted for the scheduler: the outbox holds pre-minted run ids.
					expect(r.status).toBe("accepted");
					const [row] = await u.handle.db
						.select()
						.from(brainActions)
						.where(eq(brainActions.id, r.actionId));
					expect(
						(row?.effects as { runIds?: string[] } | null)?.runIds?.length,
					).toBeGreaterThan(0);
					// ...and no run exists yet: the scheduler starts it.
					expect(await workers()).toBe(workersBefore);
				} else {
					expect(r.status).toBe("applied");
				}
			} else {
				expect(r.status).toBe("rejected");
				expect(r.rejection?.code).toBe(c.expect.rejected);
				// A rejection is information: it says what to do instead.
				expect(r.rejection?.message.length).toBeGreaterThan(0);
				expect(live.ok).toBe(false);
				if (!live.ok) expect(live.rejection.code).toBe(c.expect.rejected);
				// A rejected call has no side effect on board, runs or claims.
				expect(await snapshot(u)).toBe(before);
			}

			// Exactly one action row and one decision row, linked.
			const rows = await u.handle.db
				.select()
				.from(brainActions)
				.where(eq(brainActions.id, r.actionId));
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe(r.status);
			const [d] = await u.handle.db
				.select()
				.from(decisions)
				.where(eq(decisions.id, r.decisionId ?? -1));
			expect(d).toMatchObject({
				role: "brain",
				action: c.tool,
				turnRunId,
				brainRunId: turnRunId,
			});
			expect(d?.brainSessionId).toBe((await u.session())?.id ?? "");
			const ev = await u.handle.db
				.select()
				.from(events)
				.where(
					and(eq(events.type, "brain.action"), eq(events.runId, turnRunId)),
				);
			expect(ev.at(-1)?.payload).toMatchObject({
				actionId: r.actionId,
				tool: c.tool,
				status: r.status,
			});
		});
	}
});

describe("recording", () => {
	test("the same call in a turn returns the original result and writes nothing more", async () => {
		const args = { ...why, taskId: ids.c, role: "implement" };
		const first = await act("spawn", args);
		const again = await act("spawn", {
			...args,
			rationale: "worded differently this time",
		});
		expect(again.actionId).toBe(first.actionId);
		expect(again.duplicate).toBe(true);
		const rows = await u.handle.db.select().from(brainActions);
		expect(rows).toHaveLength(1);
		// An explicit key is a deliberate repeat.
		const second = await act("spawn", { ...args, key: "second attempt" });
		expect(second.actionId).not.toBe(first.actionId);
	});

	test("set_plan and note are the brain's own memory: applied for real, kept whole", async () => {
		const plan = `# Plan\n${"- step\n".repeat(900)}`;
		const r = await act("set_plan", { markdown: plan });
		expect(r.status).toBe("applied");
		const n = await act("note", { taskId: ids.c, text: "C looks small" });
		expect(n.status).toBe("applied");
		const latest = await u.runtime.latestPlan();
		expect(latest?.markdown).toBe(plan);
		expect(latest?.turnRunId).toBe(turnRunId);
		const [d] = await u.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, n.decisionId ?? -1));
		expect(d).toMatchObject({ kind: "note", taskId: ids.c });
	});

	test("an act call outside a live turn is refused", async () => {
		await expect(
			u.runtime.actions.act({
				turnRunId: "01NOSUCHTURN",
				tool: "note",
				args: { text: "x" },
			}),
		).rejects.toBeInstanceOf(BrainActionError);
		await expect(
			u.runtime.actions.act({ turnRunId, tool: "delete_everything", args: {} }),
		).rejects.toMatchObject({ code: "unknown_tool" });
	});

	test("caps: 8 spawns and 40 act calls per turn", async () => {
		const results: ActResult[] = [];
		for (let i = 0; i < 9; i++) {
			results.push(
				await act("spawn", {
					...why,
					taskId: ids.c,
					role: "implement",
					brief: `look ${i}`,
				}),
			);
		}
		expect(results.slice(0, 8).every((r) => r.status === "accepted")).toBe(
			true,
		);
		expect(results[8]?.rejection?.code).toBe("spawn_cap");

		// 9 calls so far, 31 more fit; then the 41st is over the cap.
		for (let i = 0; i < 31; i++) {
			const r = await act("note", { text: `n${i}` });
			expect(r.status).toBe("applied");
		}
		const over = await act("note", { text: "one too many" });
		expect(over.rejection?.code).toBe("turn_cap");
	});

	test("the same action rejected three times ends the turn", async () => {
		const bad = (i: number) => ({
			...why,
			taskId: ids.b,
			role: "implement",
			brief: `try ${i}`,
		});
		const r1 = await act("spawn", bad(1));
		const r2 = await act("spawn", bad(2));
		const r3 = await act("spawn", bad(3));
		expect([r1, r2].every((r) => r.endTurn === undefined)).toBe(true);
		expect(r3.endTurn).toBe(true);
		const r4 = await act("spawn", bad(4));
		expect(r4.rejection?.code).toBe("loop_guard");
		expect(r4.rejection?.fix?.text).toContain("brain_stuck");
	});

	test("fyi notices are limited to five a day", async () => {
		for (let i = 0; i < 5; i++) {
			const r = await act("notify_human", {
				...why,
				kind: "fyi",
				title: `t${i}`,
				body: "b",
			});
			expect(r.status).toBe("applied");
		}
		const sixth = await act("notify_human", {
			...why,
			kind: "fyi",
			title: "t6",
			body: "b",
		});
		expect(sixth.rejection?.code).toBe("fyi_rate_limited");
	});
});
