import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { brainActions, brainSessions, decisions, events } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { OverrideError } from "../src/human-override.ts";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

/**
 * P6: a person's levers on the brain. An override applies the inverse of what
 * the decision recorded, audits itself, marks the original, and tells the
 * brain; a message is durable and wakes it.
 */

let u: BrainUnit;
let turnRunId: string;
const why = { rationale: "because the frontier says so" };

beforeEach(async () => {
	u = await brainUnit({ config: { rolloverTokens: 100 } });
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
	u.runtime.actions.act({ turnRunId, tool, args: { ...why, ...args } });

const decision = async (id: number) => {
	const [d] = await u.handle.db
		.select()
		.from(decisions)
		.where(eq(decisions.id, id));
	return d;
};

const eventsOf = async (type: string) =>
	(await u.handle.db.select().from(events)).filter((e) => e.type === type);

describe("override", () => {
	test("overriding an archive restores the task, sets overridden_by, emits human.override and shows in the next rehydration digest", async () => {
		const t = await u.tasks.create({ title: "Parked", status: "backlog" });
		const archived = await act("set_status", {
			id: t.id,
			to: "archived",
			reason: "looks obsolete",
		});
		expect(archived.status).toBe("applied");
		expect((await u.tasks.get(t.id))?.status).toBe("archived");

		// The preview shows the inverse before anything is applied.
		const preview = await u.runtime.human.preview(archived.decisionId ?? 0);
		expect(preview.state).toBe("ready");
		expect(preview.summary).toContain(`move ${t.id} back to backlog`);
		expect((await u.tasks.get(t.id))?.status).toBe("archived");

		const done = await u.runtime.human.override(
			archived.decisionId ?? 0,
			"that was the migration spike, keep it",
		);

		expect((await u.tasks.get(t.id))?.status).toBe("backlog");
		const original = await decision(archived.decisionId ?? 0);
		expect(original?.overriddenBy).toBe(done.decisionId);
		const row = await decision(done.decisionId);
		expect(row).toMatchObject({
			role: "human",
			kind: "override",
			taskId: t.id,
			reason: "that was the migration spike, keep it",
			status: "ok",
		});

		const [ev] = await eventsOf("human.override");
		expect(ev?.taskId).toBe(t.id);
		expect(ev?.payload).toMatchObject({
			decisionId: done.decisionId,
			overriddenDecisionId: archived.decisionId,
			tool: "set_status",
		});

		// It wakes the brain with the `human` class and names it in the digest.
		await u.endRun(turnRunId);
		u.advance(1_000);
		await u.handle.db.update(brainSessions).set({ contextTokens: 10_000 });
		const tick = await u.runtime.tick();
		expect(tick).toMatchObject({ state: "started", wakeClass: "human" });
		const prompt = u.launched.at(-1)?.prompt ?? "";
		expect(prompt).toContain("human.override");
		expect(prompt).toContain("## Human overrides, last 7 days");
		expect(prompt).toContain(`#${done.decisionId} override set_status ${t.id}`);
		expect(prompt).toContain("that was the migration spike, keep it");
	});

	test("a reason is required and an override cannot be applied twice", async () => {
		const t = await u.tasks.create({ title: "Parked", status: "backlog" });
		const r = await act("set_status", {
			id: t.id,
			to: "archived",
			reason: "x",
		});
		const id = r.decisionId ?? 0;
		await expect(u.runtime.human.override(id, "   ")).rejects.toMatchObject({
			code: "reason_required",
		});
		expect((await u.tasks.get(t.id))?.status).toBe("archived");
		await u.runtime.human.override(id, "no");
		const again = u.runtime.human.override(id, "no again");
		await expect(again).rejects.toBeInstanceOf(OverrideError);
		await expect(again).rejects.toMatchObject({ code: "already_overridden" });
		expect(await eventsOf("human.override")).toHaveLength(1);
	});

	test("a call that was rejected, and the brain's own plan, cannot be overridden", async () => {
		const bad = await act("set_status", {
			id: "NOPE-1",
			to: "archived",
			reason: "x",
		});
		expect(bad.status).toBe("rejected");
		await expect(
			u.runtime.human.override(bad.decisionId ?? 0, "undo"),
		).rejects.toMatchObject({ code: "not_overridable" });
		const plan = await act("set_plan", { markdown: "# plan" });
		const p = await u.runtime.human.preview(plan.decisionId ?? 0);
		expect(p.state).toBe("not_applicable");
	});

	test("reparent goes back to the previous parent", async () => {
		const parent = await u.tasks.create({ title: "Epic", status: "backlog" });
		const child = await u.tasks.create({ title: "Child", status: "backlog" });
		const r = await act("reparent", { id: child.id, parent: parent.id });
		expect(r.status).toBe("applied");
		expect((await u.tasks.get(child.id))?.parentId).toBe(parent.id);
		await u.runtime.human.override(r.decisionId ?? 0, "wrong epic");
		expect((await u.tasks.get(child.id))?.parentId).toBeNull();
	});

	test("overriding create_tasks archives what it created", async () => {
		const r = await act("create_tasks", {
			tasks: [
				{ title: "A", type: "implementation", size: "s" },
				{ title: "B", type: "implementation", size: "s" },
			],
		});
		const ids = (r.result?.ids ?? []) as string[];
		expect(ids).toHaveLength(2);
		const done = await u.runtime.human.override(r.decisionId ?? 0, "no need");
		expect(done.applied).toHaveLength(2);
		for (const id of ids) {
			expect((await u.tasks.get(id))?.status).toBe("archived");
		}
	});

	test("overriding a spawn cancels it before launch, or stops the run after", async () => {
		const a = await u.tasks.create({ title: "A", status: "ready" });
		const pending = await act("spawn", { taskId: a.id, role: "implement" });
		expect(pending.status).toBe("accepted");
		await u.runtime.human.override(pending.decisionId ?? 0, "not now");
		const [row] = await u.handle.db
			.select()
			.from(brainActions)
			.where(eq(brainActions.id, pending.actionId));
		expect(row?.status).toBe("failed");
		expect(await u.runtime.executor.pendingSpawns()).toHaveLength(0);

		const b = await u.tasks.create({ title: "B", status: "ready" });
		const spawn = await act("spawn", { taskId: b.id, role: "implement" });
		for (const job of await u.runtime.executor.pendingSpawns()) {
			await u.runtime.executor.launch(job.actionId);
		}
		const runId = (await u.registry.list({ taskId: b.id }))[0]?.id ?? "";
		expect(runId).not.toBe("");
		u.effects.length = 0;
		await u.runtime.human.override(spawn.decisionId ?? 0, "wrong model");
		expect(u.effects.find((e) => e.tool === "stop")?.args).toEqual([runId]);
	});

	test("overriding a stop continues the stopped run's worktree under the override decision", async () => {
		const a = await u.tasks.create({ title: "A", status: "ready" });
		await act("spawn", { taskId: a.id, role: "implement" });
		for (const job of await u.runtime.executor.pendingSpawns()) {
			await u.runtime.executor.launch(job.actionId);
		}
		const runId = (await u.registry.list({ taskId: a.id }))[0]?.id ?? "";
		const stopped = await act("stop", { runId, reason: "looks lost" });
		expect(stopped.status).toBe("applied");
		// finalize ended it and released the claim
		await u.registry.transition(runId, "completed", {
			exitCode: 0,
			outcome: "completed",
			finishedAt: new Date(),
		});
		const [t] = [await u.tasks.get(a.id)];
		await u.tasks.release(
			a.id,
			t?.claimedByGroupId ?? runId,
			"ready",
			"scheduler",
		);

		u.effects.length = 0;
		const done = await u.runtime.human.override(
			stopped.decisionId ?? 0,
			"it was close to done",
		);
		const start = u.effects.find((e) => e.tool === "startGroupRun")
			?.args[0] as {
			taskId: string;
			decisionId: number;
			originRef: string;
			worktree: { mode: string; runId: string };
		};
		expect(start).toMatchObject({
			taskId: a.id,
			decisionId: done.decisionId,
			originRef: `human:override-${done.decisionId}`,
			worktree: { mode: "continue", runId },
		});
	});

	test("pause and resume invert each other through the hold table", async () => {
		const a = await u.tasks.create({ title: "A", status: "ready" });
		const paused = await act("pause", { taskIds: [a.id] });
		expect(Object.keys(await u.runtime.executor.holds())).toContain(a.id);
		await u.runtime.human.override(paused.decisionId ?? 0, "let it run");
		expect(Object.keys(await u.runtime.executor.holds())).not.toContain(a.id);
	});
});

describe("message the brain", () => {
	test("is durable, carries what it is about, and wakes the brain", async () => {
		const t = await u.tasks.create({ title: "Parked", status: "backlog" });
		const sent = await u.runtime.human.message({
			text: "Please leave this one for after the release.",
			about: `task:${t.id}`,
		});
		const row = await decision(sent.decisionId);
		expect(row).toMatchObject({
			role: "human",
			action: "brain.message",
			taskId: t.id,
			reason: "Please leave this one for after the release.",
		});
		const [ev] = (await eventsOf("human.brain_message")).filter(
			(e) =>
				(e.payload as { decisionId?: number }).decisionId === sent.decisionId,
		);
		expect(ev?.taskId).toBe(t.id);
		expect(ev?.payload).toMatchObject({ about: `task:${t.id}` });

		await u.endRun(turnRunId);
		u.advance(1_000);
		const tick = await u.runtime.tick();
		expect(tick).toMatchObject({ state: "started", wakeClass: "human" });
		expect(u.launched.at(-1)?.prompt).toContain(
			"Please leave this one for after the release.",
		);
	});

	test("the digest carries a long message whole, under its own heading", async () => {
		const text = `${"Hold the auth work until legal answers. ".repeat(8)}END`;
		await u.runtime.human.message({ text, about: "task:MFW-1" });
		await u.endRun(turnRunId);
		u.advance(1_000);
		await u.runtime.tick();
		const prompt = u.launched.at(-1)?.prompt ?? "";
		expect(prompt).toContain("## From the owner");
		expect(prompt).toContain(`about task:MFW-1: ${text}`);
	});

	test("refuses empty text and a malformed ref", async () => {
		await expect(u.runtime.human.message({ text: "  " })).rejects.toThrow();
		await expect(
			u.runtime.human.message({ text: "hi", about: "banana" }),
		).rejects.toThrow(/about must be/);
	});
});
