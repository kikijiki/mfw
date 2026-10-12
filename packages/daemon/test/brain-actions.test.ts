import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ulid } from "@mfw/db/ids";
import { brainActions, decisions, runGroups } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

/**
 * The live action executor over a real DB, registry, board and claim lock,
 * with the engine and merge queue doubled (see brain-unit.ts). Boot-level
 * recovery and finalize live in attempt-groups and the crash matrix.
 */

let u: BrainUnit;
let turnRunId: string;
const why = { rationale: "because the frontier says so" };

async function setup(maxConcurrent = 6) {
	u = await brainUnit({ maxConcurrent });
	await u.runtime.tick();
	await u.human("plan something");
	await u.runtime.tick();
	turnRunId = u.launched[0]?.runId ?? "";
	expect(turnRunId).not.toBe("");
}

beforeEach(async () => {
	await setup();
});
afterEach(async () => {
	await u.cleanup();
});

const act = (tool: string, args: Record<string, unknown>) =>
	u.runtime.actions.act({ turnRunId, tool, args: { ...why, ...args } });

async function ready(title: string, owns: string[] = []) {
	const t = await u.tasks.create({ title, status: "ready", owns });
	return t.id;
}

const workers = async () =>
	(await u.registry.list()).filter((r) => r.kind !== "brain");

/** What the scheduler does with the outbox: launch every pending spawn. */
async function launchAll() {
	const out = [];
	for (const job of await u.runtime.executor.pendingSpawns()) {
		out.push(await u.runtime.executor.launch(job.actionId));
	}
	return out;
}

describe("spawn", () => {
	test("the same idem_key returns the same actionId and creates exactly one run", async () => {
		const id = await ready("one");
		const first = await act("spawn", { taskId: id, role: "implement" });
		const again = await act("spawn", {
			taskId: id,
			role: "implement",
			rationale: "worded differently this time",
		});
		expect(first.status).toBe("accepted");
		expect(again.actionId).toBe(first.actionId);
		expect(again.duplicate).toBe(true);
		expect(await u.handle.db.select().from(brainActions)).toHaveLength(1);
		// the outbox row carries the pre-minted ids
		const [row] = await u.handle.db.select().from(brainActions);
		const fx = row?.effects as { runIds: string[]; groupId: string };
		expect(fx.runIds).toHaveLength(1);
		expect(fx.groupId).toBe(fx.runIds[0] as string);
		expect(await workers()).toHaveLength(0);

		// launching it, even twice, starts one run under the pre-minted id
		expect(await launchAll()).toEqual([
			{ outcome: "applied", runIds: fx.runIds },
		]);
		expect(await launchAll()).toEqual([]);
		const runs = await workers();
		expect(runs.map((r) => r.id)).toEqual(fx.runIds);
		expect(runs[0]).toMatchObject({
			role: "implement",
			groupId: fx.groupId,
			originRef: `brain:${first.actionId}`,
		});
		const [applied] = await u.handle.db
			.select()
			.from(brainActions)
			.where(eq(brainActions.id, first.actionId));
		expect(applied?.status).toBe("applied");
		expect(applied?.appliedAt).not.toBeNull();
		// the audit row is finished with the outcome
		const [d] = await u.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, first.decisionId ?? -1));
		expect(d?.output).toMatchObject({ status: "applied" });
	});

	test("an owns overlap with a running claim is rejected, with a fix", async () => {
		const a = await ready("A", ["src/a/**"]);
		const b = await ready("B", ["src/a/x.ts"]);
		await act("spawn", { taskId: a, role: "implement" });
		await launchAll();
		expect((await u.tasks.get(a))?.claimedByGroupId).not.toBeNull();

		const r = await act("spawn", { taskId: b, role: "implement" });
		expect(r.status).toBe("rejected");
		expect(r.rejection?.code).toBe("owns_overlap");
		expect(r.rejection?.fix?.kind).toBe("ui");
		expect(r.rejection?.fix?.text).toContain(a);
	});

	test("two overlapping spawns accepted before either launches: the claim lock refuses the second", async () => {
		const a = await ready("A", ["src/a/**"]);
		const b = await ready("B", ["src/a/x.ts"]);
		const first = await act("spawn", { taskId: a, role: "implement" });
		const second = await act("spawn", { taskId: b, role: "implement" });
		// both pass validation: neither claim exists yet
		expect([first.status, second.status]).toEqual(["accepted", "accepted"]);

		const outcomes = await launchAll();
		expect(outcomes[0]).toMatchObject({ outcome: "applied" });
		expect(outcomes[1]).toMatchObject({ outcome: "held", kind: "overlap" });
		// only A has a run, and B's action is still waiting, not lost
		expect((await workers()).map((r) => r.taskId)).toEqual([a]);
		const [bRow] = await u.handle.db
			.select()
			.from(brainActions)
			.where(eq(brainActions.id, second.actionId));
		expect(bRow?.status).toBe("accepted");
	});

	test("a launch the engine refuses marks the action failed, with the reason, and wakes nothing twice", async () => {
		const id = await ready("one");
		const r = await act("spawn", { taskId: id, role: "implement" });
		u.hooks.failLaunch = "worktree could not be created";
		expect(await launchAll()).toEqual([
			{ outcome: "failed", error: "worktree could not be created" },
		]);
		const [row] = await u.handle.db
			.select()
			.from(brainActions)
			.where(eq(brainActions.id, r.actionId));
		expect(row).toMatchObject({
			status: "failed",
			rejection: { code: "effect_failed" },
		});
		// failed is final: the next scheduler pass has nothing to launch
		expect(await u.runtime.executor.pendingSpawns()).toEqual([]);
	});

	test("roles that are not live yet are refused, not ignored", async () => {
		const id = await ready("one");
		const r = await act("spawn", { taskId: id, role: "research" });
		expect(r.rejection?.code).toBe("role_unavailable");
		const fork = await act("spawn", {
			taskId: id,
			role: "implement",
			worktree: "fork:01ABC",
		});
		expect(fork.rejection?.code).toBe("fork_unsupported");
		const cap = await act("spawn", {
			taskId: id,
			role: "implement",
			maxUsd: 1,
		});
		expect(cap.rejection?.code).toBe("max_usd_unsupported");
	});
});

describe("spawn_attempts", () => {
	test("one inadmissible variant creates nothing", async () => {
		const id = await ready("compete");
		const r = await act("spawn_attempts", {
			taskId: id,
			variants: [{ model: "sonnet" }, { effort: "turbo" }],
			selection: "brain",
		});
		expect(r.status).toBe("rejected");
		expect(r.rejection?.code).toBe("invalid_effort");
		expect(r.rejection?.message).toContain("variant 1");
		expect(r.rejection?.fix).toBeDefined();
		// nothing in the outbox that could launch, no group, no run
		expect(await u.runtime.executor.pendingSpawns()).toEqual([]);
		expect(await u.handle.db.select().from(runGroups)).toEqual([]);
		expect(await workers()).toEqual([]);
		expect(await u.runtime.executor.reservedSlots()).toBe(0);
	});

	test("no partial fan-out: variants that exceed the free slots are rejected whole", async () => {
		await u.cleanup();
		await setup(2);
		const id = await ready("compete");
		const r = await act("spawn_attempts", {
			taskId: id,
			variants: [{}, {}, {}],
			selection: "brain",
		});
		expect(r.status).toBe("rejected");
		expect(["capacity", "attempt_cap"]).toContain(r.rejection?.code ?? "");
		expect(await workers()).toEqual([]);
	});

	test("accepted attempts get one competing group and pre-minted runs; slots are promised", async () => {
		const id = await ready("compete");
		const r = await act("spawn_attempts", {
			taskId: id,
			variants: [{ model: "sonnet" }, { model: "opus" }],
			selection: "first_verified",
		});
		expect(r.status).toBe("accepted");
		expect(await u.runtime.executor.reservedSlots()).toBe(2);
		const outcome = (await launchAll())[0];
		expect(outcome).toMatchObject({ outcome: "applied" });
		const runs = await workers();
		expect(runs).toHaveLength(2);
		expect(new Set(runs.map((x) => x.groupId)).size).toBe(1);
		expect(runs.map((x) => x.role)).toEqual(["attempt", "attempt"]);
		const [group] = await u.handle.db.select().from(runGroups);
		expect(group).toMatchObject({
			kind: "competing",
			selection: "first_verified",
			createdByAction: r.actionId,
		});
		const task = await u.tasks.get(id);
		expect(task?.claimedByGroupId).toBe(group?.id);
		expect(await u.runtime.executor.reservedSlots()).toBe(0);
	});
});

describe("the other live tools", () => {
	test("pause holds a task out of spawning until resume", async () => {
		const id = await ready("one");
		const paused = await act("pause", { taskIds: [id] });
		expect(paused.status).toBe("applied");
		const refused = await act("spawn", { taskId: id, role: "implement" });
		expect(refused.rejection?.code).toBe("task_paused");
		expect((await u.runtime.executor.holds())[id]?.by).toBe("pause");

		await act("resume", { taskIds: [id] });
		expect(await u.runtime.executor.holds()).toEqual({});
		// (a rejected call is replayed as rejected within a turn; `key` is the
		// deliberate repeat)
		const ok = await act("spawn", {
			taskId: id,
			role: "implement",
			key: "after resume",
		});
		expect(ok.status).toBe("accepted");
	});

	test("stop and steer reach the engine; notify_human holds the blocked task and records an escalation", async () => {
		const id = await ready("one");
		await act("spawn", { taskId: id, role: "implement" });
		await launchAll();
		const run = (await workers())[0];
		const stopped = await act("stop", { runId: run?.id, reason: "wrong" });
		expect(stopped.status).toBe("applied");
		expect(u.effects.some((e) => e.tool === "stop")).toBe(true);

		const n = await act("notify_human", {
			kind: "product_decision",
			title: "Pick a database",
			body: "two options",
			blocking: [id],
		});
		expect(n.status).toBe("applied");
		expect((await u.runtime.executor.holds())[id]?.by).toBe("awaiting_human");
		const [d] = await u.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, n.decisionId ?? -1));
		expect(d?.kind).toBe("escalation");
	});

	test("an fyi never holds the tasks it names", async () => {
		const id = await ready("one");
		const n = await act("notify_human", {
			kind: "fyi",
			title: "Dispatch is stopped",
			body: "nothing can start",
			blocking: [id],
		});
		expect(n.status).toBe("applied");
		expect(await u.runtime.executor.holds()).toEqual({});
	});

	test("sleep stores the wake hint on the session", async () => {
		const r = await act("sleep", { wakeAfterMin: 45, wakeOn: ["settled"] });
		expect(r.status).toBe("applied");
		expect((await u.session())?.wakeHint).toMatchObject({ wakeAfterMin: 45 });
	});

	test("a board tool writes the board and is applied, with the action as provenance", async () => {
		const id = await ready("one");
		const r = await act("set_status", { id, to: "blocked", reason: "x" });
		expect(r.status).toBe("applied");
		const t = await u.tasks.get(id);
		expect(t?.status).toBe("blocked");
		expect(t?.editedBy).toBe(`brain:${r.actionId}`);
	});
});

describe("recover()", () => {
	test("replays an accepted non-spawn effect once; applied rows are left alone", async () => {
		const id = await ready("one");
		await act("spawn", { taskId: id, role: "implement" });
		await launchAll();
		const run = (await workers())[0];
		// An accepted stop whose effect never ran (crash after the outbox commit).
		const [turn] = await u.turns();
		await u.handle.db.insert(brainActions).values({
			id: ulid(),
			idemKey: ulid(),
			sessionId: turn?.sessionId ?? "",
			turnRunId,
			tool: "stop",
			args: { runId: run?.id, reason: "crash test" },
			status: "accepted",
			effects: {},
			createdAt: new Date(),
		});
		const before = u.effects.filter((e) => e.tool === "stop").length;
		const report = await u.runtime.executor.recover();
		expect(report.replayed).toBe(1);
		expect(u.effects.filter((e) => e.tool === "stop").length).toBe(before + 1);
		// a second recovery has nothing to do
		const again = await u.runtime.executor.recover();
		expect(again).toEqual({ adopted: 0, pending: 0, replayed: 0 });
		expect(u.effects.filter((e) => e.tool === "stop").length).toBe(before + 1);
	});
});
