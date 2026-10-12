import "./support/tmux-test-socket.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { decisions, runGroups } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { type FlowNode, flowTree } from "../src/flow.ts";
import { groupView } from "../src/group-view.ts";
import { rerouteRun } from "../src/reroute.ts";
import { taskStory } from "../src/story.ts";
import { type GroupFixture, groupFixture } from "./support/group-fixture.ts";

/**
 * Real `run_groups` in the flow tree and the Story, the compare view's group
 * read (with the server's own select verdicts), a person's winner selection
 * (a human override through the same validator and effect) and reroute.
 */

let fx: GroupFixture | undefined;
afterEach(async () => {
	await fx?.cleanup();
	fx = undefined;
});

async function twoAttempts(f: GroupFixture, fail: number[] = []) {
	const taskId = await f.task("compete");
	const proposed = await f.act("spawn_attempts", {
		taskId,
		variants: [{ model: "sonnet" }, { model: "opus" }],
		selection: "brain",
	});
	expect(proposed.status).toBe("accepted");
	const runIds = (proposed.result?.runIds ?? []) as string[];
	const groupId = String(proposed.result?.groupId);
	if (fail.length > 0) {
		await f.control({ fail: fail.map((i) => runIds[i] ?? "") });
	}
	await f.svc.scheduler.tick();
	await f.until(
		async () => {
			const rows = await Promise.all(
				runIds.map((id) => f.svc.registry.get(id)),
			);
			return rows.every(
				(r) =>
					r &&
					["completed", "failed", "killed", "finalize_error"].includes(r.state),
			);
		},
		{ what: "the attempts to settle", timeoutMs: 60_000 },
	);
	return { taskId, runIds, groupId };
}

const treeOf = async (f: GroupFixture) =>
	flowTree(f.svc.handle.db, {
		tasks: (await f.svc.tasks.list()).map((t) => ({
			id: t.id,
			title: t.title,
			status: t.status,
			type: t.type,
			parentId: t.parentId ?? null,
			updatedAt: t.updatedAt,
			createdAt: t.createdAt,
		})),
		ended: "all",
	});

describe("attempt groups as nodes", () => {
	test("flow.tree and the Story carry the real run_groups row: a group node, its attempts, the winner", async () => {
		fx = await groupFixture();
		const f = fx;
		const { taskId, runIds, groupId } = await twoAttempts(f);

		const before = await treeOf(f);
		const group = before.nodes.find((n) => n.ref === `group:${groupId}`);
		expect(group).toMatchObject({
			kind: "group",
			parent: `task:${taskId}`,
			group: {
				kind: "competing",
				selection: "brain",
				status: "open",
				winner: null,
				attempts: 2,
			},
		});
		// the group was made by the brain's spawn_attempts decision
		expect(group?.group?.createdBy).toMatch(/^decision:\d+$/);
		for (const id of runIds) {
			const node = before.nodes.find((n) => n.ref === `run:${id}`) as FlowNode;
			expect(node.parent).toBe(`group:${groupId}`);
			expect(node.run?.attempt).toEqual({
				groupRef: `group:${groupId}`,
				role: "attempt",
				winner: false,
			});
		}

		const page = await taskStory(f.svc.handle.db, { taskId });
		const entry = page.entries.find((e) => e.kind === "group");
		expect(entry).toMatchObject({
			kind: "group",
			ref: `group:${groupId}`,
			group: { kind: "competing", status: "open", winnerRunId: null },
		});
		if (entry?.kind !== "group") throw new Error("no group entry");
		expect(entry.attempts.map((a) => a.ref).sort()).toEqual(
			runIds.map((id) => `run:${id}`).sort(),
		);
		// attempts are not also top-level run entries
		expect(page.entries.filter((e) => e.kind === "run")).toEqual([]);

		// a winner is marked on the group, the run and the story
		const out = await f.svc.brainRuntime.actions.selectWinnerAsHuman({
			runId: runIds[0] as string,
			groupId,
		});
		expect(out.ok).toBe(true);
		const after = await treeOf(f);
		expect(
			after.nodes.find((n) => n.ref === `group:${groupId}`)?.group,
		).toMatchObject({
			status: "selecting",
			winner: `run:${runIds[0]}`,
		});
		expect(
			after.nodes.find((n) => n.ref === `run:${runIds[0]}`)?.run?.attempt
				?.winner,
		).toBe(true);
		expect(
			after.nodes.find((n) => n.ref === `run:${runIds[1]}`)?.run?.attempt
				?.winner,
		).toBe(false);
	}, 120_000);

	test("a group of one has no group node and its run stays under the task", async () => {
		fx = await groupFixture();
		const f = fx;
		const taskId = await f.task("solo");
		const r = await f.spawn(taskId);
		const runId = String(
			r.result?.runIds ? (r.result.runIds as string[])[0] : "",
		);
		await f.svc.scheduler.tick();
		const tree = await treeOf(f);
		expect(tree.nodes.filter((n) => n.kind === "group")).toEqual([]);
		expect(tree.nodes.find((n) => n.ref === `run:${runId}`)?.parent).toBe(
			`task:${taskId}`,
		);
	}, 60_000);
});

describe("groups.get and a person's select_winner", () => {
	test("each attempt carries the server's own select verdict; a person's selection is a human decision", async () => {
		fx = await groupFixture();
		const f = fx;
		const { runIds, groupId } = await twoAttempts(f, [1]);
		const deps = {
			registry: f.svc.registry,
			actions: f.svc.brainRuntime.actions,
			executor: f.svc.brainRuntime.executor,
			db: f.svc.handle.db,
		};
		const view = await groupView(deps, groupId);
		expect(view?.status).toBe("open");
		const good = view?.attempts.find((a) => a.runId === runIds[0]);
		const bad = view?.attempts.find((a) => a.runId === runIds[1]);
		expect(good?.select).toEqual({ ok: true });
		expect(good?.facts).toMatchObject({ settled: true, verified: true });
		expect(bad?.select).toMatchObject({
			ok: false,
			rejection: { code: "not_verified" },
		});
		expect(bad?.facts.verified).toBe(false);

		// the server refuses the unverified one with its fix text
		const refused = await f.svc.brainRuntime.actions.selectWinnerAsHuman({
			runId: runIds[1] as string,
			groupId,
		});
		expect(refused).toMatchObject({
			ok: false,
			rejection: { code: "not_verified" },
		});
		if (refused.ok) throw new Error("accepted");
		expect(refused.rejection.fix?.text.length).toBeGreaterThan(0);
		// and recorded nothing
		expect(
			await f.svc.handle.db
				.select()
				.from(decisions)
				.where(eq(decisions.role, "human")),
		).toEqual([]);

		const picked = await f.svc.brainRuntime.actions.selectWinnerAsHuman({
			runId: runIds[0] as string,
			groupId,
			reason: "cleaner diff",
		});
		expect(picked.ok).toBe(true);
		const rows = await f.svc.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.role, "human"));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: "select_winner",
			kind: "override",
			subjectRunId: runIds[0],
			reason: "cleaner diff",
			status: "ok",
		});
		expect((rows[0]?.output as { status: string }).status).toBe("applied");
		const [g] = await f.svc.handle.db
			.select()
			.from(runGroups)
			.where(eq(runGroups.id, groupId));
		expect(g).toMatchObject({ status: "selecting", winnerRunId: runIds[0] });

		// decided: the same call is now refused as a closed group
		const again = await f.svc.brainRuntime.actions.selectWinnerAsHuman({
			runId: runIds[0] as string,
			groupId,
		});
		expect(again).toMatchObject({
			ok: false,
			rejection: { code: "group_closed" },
		});
		const final = await groupView(deps, groupId);
		expect(final?.selectedBy).toMatchObject({
			role: "human",
			runId: runIds[0],
			reason: "cleaner diff",
		});
	}, 120_000);
});

describe("reroute", () => {
	test("stops the run keeping its worktree, then continues it on another model as a human decision", async () => {
		fx = await groupFixture();
		const f = fx;
		await f.control({ slowMs: 30_000 });
		const taskId = await f.task("slow");
		const spawned = await f.spawn(taskId);
		const oldId = (spawned.result?.runIds as string[])[0] as string;
		await f.svc.scheduler.tick();
		const live = await f.svc.registry.get(oldId);
		expect(live?.state).toBe("running");
		const worktree = live?.worktreePath;
		await f.control({});

		let done = false;
		const rerouted = rerouteRun(
			{
				handle: f.svc.handle,
				bus: f.svc.bus,
				registry: f.svc.registry,
				engine: f.svc.engine,
				wake: () => {},
				settleMs: 50_000,
			},
			{ runId: oldId, model: "opus", reason: "needs a stronger model" },
		).finally(() => {
			done = true;
		});
		await f.until(async () => done, { what: "the reroute", timeoutMs: 60_000 });
		const out = await rerouted;

		const stopped = await f.svc.registry.get(oldId);
		expect(["killed", "failed", "interrupted", "completed"]).toContain(
			stopped?.state as string,
		);
		const next = await f.svc.registry.get(out.runId);
		expect(next).toMatchObject({
			taskId,
			relation: "continue",
			parentRunId: oldId,
			worktreePath: worktree,
			model: "opus",
			originRef: "human:ui",
			spawnedByDecisionId: out.decisionId,
		});
		const [d] = await f.svc.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, out.decisionId));
		expect(d).toMatchObject({
			role: "human",
			kind: "override",
			action: "reroute",
			subjectRunId: oldId,
			reason: "needs a stronger model",
		});
		// the run's spawning decision is marked as reversed by this one
		const [orig] = await f.svc.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, stopped?.spawnedByDecisionId ?? -1));
		expect(orig?.overriddenBy).toBe(out.decisionId);
	}, 120_000);

	test("refuses a reroute that changes nothing, with a fix", async () => {
		fx = await groupFixture();
		const f = fx;
		const taskId = await f.task("noop");
		const spawned = await f.spawn(taskId);
		const id = (spawned.result?.runIds as string[])[0] as string;
		await f.svc.scheduler.tick();
		await expect(
			rerouteRun(
				{
					handle: f.svc.handle,
					bus: f.svc.bus,
					registry: f.svc.registry,
					engine: f.svc.engine,
				},
				{ runId: id },
			),
		).rejects.toMatchObject({ code: "nothing_to_change" });
		expect(
			await f.svc.handle.db
				.select()
				.from(decisions)
				.where(eq(decisions.role, "human")),
		).toEqual([]);
	}, 60_000);
});

describe("add attempt, resume and holds by a person", () => {
	test("addAttempt goes through the spawn validator and joins the open group; the cap refuses with a fix", async () => {
		fx = await groupFixture();
		const f = fx;
		const { runIds, groupId, taskId } = await twoAttempts(f);
		const out = await f.svc.brainRuntime.actions.addAttemptAsHuman({
			groupId,
			model: "haiku",
			reason: "try a cheaper model too",
		});
		expect(out.ok).toBe(true);
		if (!out.ok) throw new Error("refused");
		const added = await f.svc.registry.get(out.runId);
		expect(added).toMatchObject({
			groupId,
			role: "attempt",
			taskId,
			model: "haiku",
			originRef: "human:ui",
			spawnedByDecisionId: out.decisionId,
		});
		const members = await f.svc.registry.groupRuns(groupId);
		expect(members.map((m) => m.id)).toContain(out.runId);
		expect(members).toHaveLength(runIds.length + 1);
		const [d] = await f.svc.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, out.decisionId));
		expect(d).toMatchObject({
			role: "human",
			action: "add_attempt",
			reason: "try a cheaper model too",
		});

		// three is the cap: the fourth is refused with the validator's fix text
		const again = await f.svc.brainRuntime.actions.addAttemptAsHuman({
			groupId,
		});
		expect(again).toMatchObject({
			ok: false,
			rejection: { code: "attempt_cap" },
		});
		if (again.ok) throw new Error("accepted");
		expect(again.rejection.fix?.text.length).toBeGreaterThan(0);
	}, 120_000);

	test("keepRoute resumes a settled attempt on its own route inside its group", async () => {
		fx = await groupFixture();
		const f = fx;
		const { runIds, groupId } = await twoAttempts(f, [1]);
		const failed = await f.svc.registry.get(runIds[1] as string);
		expect(failed?.state).toBe("failed");
		const out = await rerouteRun(
			{
				handle: f.svc.handle,
				bus: f.svc.bus,
				registry: f.svc.registry,
				engine: f.svc.engine,
			},
			{ runId: runIds[1] as string, keepRoute: true },
		);
		expect(out.groupId).toBe(groupId);
		const next = await f.svc.registry.get(out.runId);
		expect(next).toMatchObject({
			groupId,
			role: "attempt",
			relation: "continue",
			parentRunId: runIds[1],
			model: failed?.model,
		});
		const [d] = await f.svc.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, out.decisionId));
		expect(d).toMatchObject({ role: "human", action: "resume" });
	}, 120_000);

	test("pause and resume write the brain's own hold store as a human decision, and the spawn validator honours it", async () => {
		fx = await groupFixture();
		const f = fx;
		const taskId = await f.task("held");
		const paused = await f.svc.brainRuntime.actions.holdAsHuman({
			taskIds: [taskId],
			paused: true,
			reason: "waiting for the design call",
		});
		expect(paused.taskIds).toEqual([taskId]);
		const holds = await f.svc.brainRuntime.executor.holds();
		expect(holds[taskId]).toMatchObject({
			by: "human",
			reason: "waiting for the design call",
			actionId: `human:${paused.decisionId}`,
		});
		const refused = await f.svc.brainRuntime.actions.check("spawn", {
			taskId,
			role: "implement",
			rationale: "go",
		});
		expect(refused).toMatchObject({
			ok: false,
			rejection: { code: "task_paused" },
		});
		const [d] = await f.svc.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, paused.decisionId));
		expect(d).toMatchObject({ role: "human", action: "pause", taskId });

		await f.svc.brainRuntime.actions.holdAsHuman({
			taskIds: [taskId],
			paused: false,
		});
		expect((await f.svc.brainRuntime.executor.holds())[taskId]).toBeUndefined();
		const ok = await f.svc.brainRuntime.actions.check("spawn", {
			taskId,
			role: "implement",
			rationale: "go",
		});
		expect(ok.ok).toBe(true);
	}, 60_000);
});
