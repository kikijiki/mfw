import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { brainActions, decisions } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { getBoardTemplate } from "../src/board-templates.ts";
import { InjectedExecutorCrash } from "../src/brain-runtime/executor.ts";
import { classifyEvent } from "../src/brain-runtime/wake-table.ts";
import { defaultBoardYaml } from "../src/default-board-config.ts";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

/**
 * P4: the brain's board authority. The tools write the board through the same
 * paths a person's edits take (locks, rev checks, the board's own hierarchy and
 * rule gates, the status map), carry their provenance in the frontmatter, and
 * survive a crash between the board write and `applied` without duplicating.
 */

let u: BrainUnit;
let turnRunId: string;
const why = { rationale: "the plan says so" };

async function setup(opts: Parameters<typeof brainUnit>[0] = {}) {
	u = await brainUnit(opts);
	await u.runtime.tick();
	await u.human("plan something");
	await u.runtime.tick();
	turnRunId = u.launched[0]?.runId ?? "";
	expect(turnRunId).not.toBe("");
}

afterEach(async () => {
	await u?.cleanup();
});

const act = (tool: string, args: Record<string, unknown>) =>
	u.runtime.actions.act({ turnRunId, tool, args: { ...why, ...args } });

const spec = (title: string, extra: Record<string, unknown> = {}) => ({
	title,
	type: "implementation",
	size: "s",
	...extra,
});

const titles = async () => (await u.tasks.list()).map((t) => t.title).sort();

/** The default mfw board plus a hierarchy block: epics hold work, depth 2. */
function hierarchyYaml(): string {
	const base = defaultBoardYaml("MFW").replace(
		"      parent: { ref: task, optional: true }\n",
		"      parent: { ref: task, optional: true }\n      children: { ref: task, list: true }\n",
	);
	return `${base}
hierarchy:
  parent: parent
  children: children
  maxDepth: 2
  rules:
    - child: { type: task, where: { type: [implementation, spike] } }
      parents: [{ type: task, where: { type: [epic] } }]
    - child: { type: task, where: { type: [epic] } }
      parents: [{ type: task, where: { type: [epic] } }]
`;
}

describe("create_tasks", () => {
	test("creates the batch, resolves refs, and stamps who wrote each task", async () => {
		await setup();
		const r = await act("create_tasks", {
			tasks: [
				spec("Build the thing", { ref: "build", depends_on: ["groundwork"] }),
				spec("Groundwork", { ref: "groundwork", owns: ["src/g/**"] }),
				spec("Epic", { ref: "epic", type: "epic" }),
				spec("Child", { parent: "epic" }),
			],
		});
		expect(r.status).toBe("applied");
		const made = await u.tasks.list();
		expect(made).toHaveLength(4);
		const by = (title: string) => made.find((t) => t.title === title);
		expect(by("Build the thing")?.dependsOn).toEqual([
			by("Groundwork")?.id as string,
		]);
		expect(by("Child")?.parentId).toBe(by("Epic")?.id as string);
		for (const t of made) {
			expect(t.createdBy).toMatch(new RegExp(`^brain:${r.actionId}#[0-3]$`));
			expect(t.source).toBe("planner");
		}
		// the audit row is finished and points at the first task written
		const [d] = await u.handle.db
			.select()
			.from(decisions)
			.where(eq(decisions.id, r.decisionId ?? -1));
		expect(d?.output).toMatchObject({ status: "applied" });
		expect(r.result?.ids).toHaveLength(4);
	});

	test("a cycle through the batch creates nothing", async () => {
		await setup();
		const before = await u.tasks.list();
		const r = await act("create_tasks", {
			tasks: [
				spec("A", { ref: "a", depends_on: ["b"] }),
				spec("B", { ref: "b", depends_on: ["c"] }),
				spec("C", { ref: "c", depends_on: ["a"] }),
				spec("Innocent"),
			],
		});
		expect(r.status).toBe("rejected");
		expect(r.rejection?.code).toBe("dependency_cycle");
		expect(r.rejection?.message).toContain("a -> b -> c -> a");
		expect(await u.tasks.list()).toHaveLength(before.length);
	});

	test("a task may not be its own parent or dependency", async () => {
		await setup();
		const r = await act("create_tasks", {
			tasks: [spec("Loop", { ref: "loop", parent: "loop" })],
		});
		expect(r.rejection?.code).toBe("hierarchy_cycle");
		expect(await u.tasks.list()).toHaveLength(0);
	});

	test("new owns must be ordered against live work", async () => {
		await setup();
		const live = await u.tasks.create({
			title: "Live",
			status: "ready",
			owns: ["src/a/**"],
		});
		const bad = await act("create_tasks", {
			tasks: [spec("Clash", { owns: ["src/a/x.ts"] })],
		});
		expect(bad.status).toBe("rejected");
		expect(bad.rejection?.code).toBe("owns_unordered");
		expect(bad.rejection?.fix?.text).toContain(live.id);
		const ok = await act("create_tasks", {
			tasks: [spec("Ordered", { owns: ["src/a/x.ts"], depends_on: [live.id] })],
		});
		expect(ok.status).toBe("applied");
	});

	test("a crash after the board write, before applied, does not duplicate on replay", async () => {
		await setup();
		u.hooks.crashAt = (p) => {
			if (p === "board.before_applied") throw new InjectedExecutorCrash(p);
		};
		await expect(
			act("create_tasks", {
				tasks: [
					spec("One", { ref: "one" }),
					spec("Two", { depends_on: ["one"] }),
				],
			}),
		).rejects.toThrow(/injected crash/);
		// the board has the tasks; the action is still only accepted
		expect(await titles()).toEqual(["One", "Two"]);
		const [row] = await u.handle.db.select().from(brainActions);
		expect(row?.status).toBe("accepted");

		u.hooks.crashAt = undefined;
		const out = await u.runtime.executor.recover();
		expect(out.replayed).toBe(1);
		expect(await titles()).toEqual(["One", "Two"]);
		const [after] = await u.handle.db.select().from(brainActions);
		expect(after?.status).toBe("applied");
		// replaying again changes nothing
		expect((await u.runtime.executor.recover()).replayed).toBe(0);
		expect(await u.tasks.list()).toHaveLength(2);
	});

	test("a crash half way through the batch is finished by the replay, each task once", async () => {
		await setup();
		let writes = 0;
		u.hooks.crashAt = (p) => {
			if (p === "board.after_write" && ++writes === 1) {
				throw new InjectedExecutorCrash(p);
			}
		};
		await expect(
			act("create_tasks", {
				tasks: [spec("A"), spec("B"), spec("C")],
			}),
		).rejects.toThrow(/injected crash/);
		expect(await u.tasks.list()).toHaveLength(1);
		u.hooks.crashAt = undefined;
		await u.runtime.executor.recover();
		expect(await titles()).toEqual(["A", "B", "C"]);
	});

	test("a refusal while writing removes what the call wrote", async () => {
		await setup();
		// The validator would catch this; the store is the last line.
		await expect(
			u.tasks.createBatch(
				[{ title: "First" }, { title: "Second", owns: ["../outside"] }],
				{ actionId: "01TEST" },
			),
		).rejects.toThrow();
		expect(await u.tasks.list()).toHaveLength(0);
	});

	test("created tasks do not wake the brain that wrote them", async () => {
		const own = classifyEvent(
			{
				seq: 1,
				ts: 0,
				type: "task.created",
				payload: { source: "planner", title: "x", createdBy: "brain:01A#0" },
			},
			() => undefined,
		);
		const human = classifyEvent(
			{
				seq: 2,
				ts: 0,
				type: "task.created",
				payload: { source: "human", title: "x" },
			},
			() => undefined,
		);
		expect(own).toBeNull();
		expect(human).toBe("frontier");
	});
});

describe("update_task", () => {
	test("applies under the rev it read, stamps edited_by and bumps the rev once", async () => {
		await setup();
		const t = await u.tasks.create({ title: "Old", status: "ready" });
		const r = await act("update_task", {
			id: t.id,
			baseRev: t.contentRev,
			patch: { title: "New", labels: ["x"] },
		});
		expect(r.status).toBe("applied");
		const now = await u.tasks.get(t.id);
		expect(now?.title).toBe("New");
		expect(now?.editedBy).toBe(`brain:${r.actionId}`);
		expect(now?.contentRev).toBe(t.contentRev + 1);
	});

	test("an edit of a rev a person has moved past is stale_rev", async () => {
		await setup();
		const t = await u.tasks.create({ title: "Mine", status: "ready" });
		await u.tasks.edit(t.id, { title: "Human edit" }, { source: "api" });
		const r = await act("update_task", {
			id: t.id,
			baseRev: t.contentRev,
			patch: { title: "Brain edit" },
		});
		expect(r.status).toBe("rejected");
		expect(r.rejection?.code).toBe("stale_rev");
		expect((await u.tasks.get(t.id))?.title).toBe("Human edit");
	});

	test("a human edit that lands between the check and the write is stale_rev, not lost", async () => {
		await setup();
		const t = await u.tasks.create({
			title: "Racy",
			status: "ready",
			owns: ["src/r/**"],
		});
		u.hooks.crashAt = (p) => {
			if (p === "board.before_owns_recheck") {
				return u.tasks
					.edit(t.id, { title: "Human got there first" }, { source: "api" })
					.then(() => undefined);
			}
		};
		const r = await act("update_task", {
			id: t.id,
			baseRev: t.contentRev,
			patch: { owns: ["src/r/lib/**"] },
		});
		expect(r.status).toBe("failed");
		expect(r.rejection?.code).toBe("stale_rev");
		const now = await u.tasks.get(t.id);
		expect(now?.title).toBe("Human got there first");
		expect(now?.owns).toEqual(["src/r/**"]);
	});

	test("an owns edit overlapping a claimed group is refused under the claim lock", async () => {
		await setup();
		const a = await u.tasks.create({
			title: "A",
			status: "ready",
			owns: ["src/a/**"],
		});
		const b = await u.tasks.create({
			title: "B",
			status: "ready",
			owns: ["src/b/**"],
		});
		expect(await u.tasks.tryClaim(a.id, "group-a", 60_000)).toBe(true);
		const current = await u.tasks.get(a.id);
		// Valid when checked: B holds nothing yet. B's group claims it before the
		// edit takes the claim lock.
		u.hooks.crashAt = (p) => {
			if (p === "board.before_owns_recheck") {
				return u.tasks.tryClaim(b.id, "group-b", 60_000).then(() => undefined);
			}
		};
		const r = await act("update_task", {
			id: a.id,
			baseRev: current?.contentRev,
			patch: { owns: ["src/a/**", "src/b/x.ts"] },
		});
		expect(r.status).toBe("failed");
		expect(r.rejection?.code).toBe("owns_overlap");
		expect(r.rejection?.message).toContain(b.id);
		expect((await u.tasks.get(a.id))?.owns).toEqual(["src/a/**"]);
	});

	test("a replay after a crash is not a stale_rev: the edit is already on the file", async () => {
		await setup();
		const t = await u.tasks.create({ title: "Before", status: "ready" });
		u.hooks.crashAt = (p) => {
			if (p === "board.before_applied") throw new InjectedExecutorCrash(p);
		};
		await expect(
			act("update_task", {
				id: t.id,
				baseRev: t.contentRev,
				patch: { title: "After" },
			}),
		).rejects.toThrow(/injected crash/);
		const mid = await u.tasks.get(t.id);
		expect(mid?.title).toBe("After");
		u.hooks.crashAt = undefined;
		await u.runtime.executor.recover();
		const [row] = await u.handle.db.select().from(brainActions);
		expect(row?.status).toBe("applied");
		expect((await u.tasks.get(t.id))?.contentRev).toBe(mid?.contentRev ?? -1);
	});
});

describe("reparent on a board with hierarchy rules", () => {
	async function hierarchical() {
		await setup({ boardYaml: hierarchyYaml() });
		const epic = await u.tasks.create({ title: "Epic", type: "epic" });
		const epic2 = await u.tasks.create({ title: "Epic 2", type: "epic" });
		const work = await u.tasks.create({
			title: "Work",
			type: "implementation",
			parentId: epic.id,
		});
		const spike = await u.tasks.create({ title: "Spike", type: "spike" });
		return { epic, epic2, work, spike };
	}

	test("moves a task between parents, keeping the board's children lists in sync", async () => {
		const { epic, epic2, work } = await hierarchical();
		const r = await act("reparent", { id: work.id, parent: epic2.id });
		expect(r.status).toBe("applied");
		expect((await u.tasks.get(work.id))?.parentId).toBe(epic2.id);
		const read = async (id: string) =>
			readFile(u.tasks.store.get(id)?.path as string, "utf8");
		expect(await read(epic2.id)).toContain(work.id);
		expect(await read(epic.id)).not.toContain(work.id);
		// and to the top
		const top = await act("reparent", { id: work.id, parent: null });
		expect(top.status).toBe("applied");
		expect((await u.tasks.get(work.id))?.parentId).toBeNull();
	});

	test("the type rules of board.yaml refuse a parent of the wrong type", async () => {
		const { work, spike } = await hierarchical();
		// work (implementation) may only sit under an epic
		const r = await act("reparent", { id: work.id, parent: spike.id });
		expect(r.status).toBe("rejected");
		expect(r.rejection?.code).toBe("parent_type_not_allowed");
		expect((await u.tasks.get(work.id))?.parentId).not.toBe(spike.id);
	});

	test("maxDepth bounds the parent chain, counting the subtree that moves", async () => {
		const { epic, epic2, work } = await hierarchical();
		// epic2 under epic: chain epic > epic2 > (nothing) is 1 deep: fine
		const ok = await act("reparent", { id: epic2.id, parent: epic.id });
		expect(ok.status).toBe("applied");
		// a third epic under epic2 makes epic > epic2 > epic3 (2 ancestors)...
		const epic3 = await u.tasks.create({ title: "Epic 3", type: "epic" });
		const mid = await act("reparent", { id: epic3.id, parent: epic2.id });
		expect(mid.status).toBe("applied");
		// ...and work (under epic) cannot go below epic3: 3 ancestors
		const deep = await act("reparent", { id: work.id, parent: epic3.id });
		expect(deep.status).toBe("rejected");
		expect(deep.rejection?.code).toBe("max_depth");
	});

	test("a descendant is not a parent", async () => {
		const { epic, epic2 } = await hierarchical();
		await act("reparent", { id: epic2.id, parent: epic.id });
		const r = await act("reparent", { id: epic.id, parent: epic2.id });
		expect(r.status).toBe("rejected");
		expect(r.rejection?.code).toBe("hierarchy_cycle");
	});

	test("create_tasks and split_task obey the same rules", async () => {
		const { spike } = await hierarchical();
		const r = await act("create_tasks", {
			tasks: [spec("Under a spike", { parent: spike.id })],
		});
		expect(r.status).toBe("rejected");
		expect(r.rejection?.code).toBe("parent_type_not_allowed");
		// inside one batch: an implementation task under another implementation task
		const batch = await act("create_tasks", {
			tasks: [
				spec("Outer", { ref: "outer" }),
				spec("Inner", { parent: "outer" }),
			],
		});
		expect(batch.rejection?.code).toBe("parent_type_not_allowed");
		const ok = await act("create_tasks", {
			tasks: [
				spec("Fresh epic", { ref: "e", type: "epic" }),
				spec("Its work", { parent: "e" }),
			],
		});
		expect(ok.status).toBe("applied");
	});
});

describe("a flat board with its own statuses", () => {
	const planning = () => {
		const t = getBoardTemplate("planning");
		if (!t) throw new Error("planning template missing");
		return t.yaml("MFW");
	};

	test("create, reparent and set_status go through the status map", async () => {
		await setup({ boardYaml: planning() });
		const made = await act("create_tasks", {
			tasks: [
				spec("Parent", { ref: "p", type: "epic" }),
				spec("Child", { parent: "p" }),
				spec("Other"),
			],
		});
		expect(made.status).toBe("applied");
		const all = await u.tasks.list();
		const [parent, child, other] = ["Parent", "Child", "Other"].map(
			(n) => all.find((t) => t.title === n) as (typeof all)[number],
		);
		expect(child?.parentId).toBe(parent?.id as string);

		const moved = await act("reparent", {
			id: child?.id,
			parent: null,
		});
		expect(moved.status).toBe("applied");

		const blocked = await act("set_status", {
			id: other?.id,
			to: "blocked",
			reason: "waiting on a person",
		});
		expect(blocked.status).toBe("applied");
		expect((await u.tasks.get(other?.id ?? ""))?.status).toBe("blocked");
		// the file holds the board's word for it
		const file = (await u.tasks.store.get(other?.id ?? ""))?.path as string;
		expect(await readFile(file, "utf8")).toContain("status: deferred");

		const archived = await act("set_status", {
			id: other?.id,
			to: "archived",
			reason: "not needed",
		});
		expect(archived.status).toBe("applied");
		expect(await readFile(file, "utf8")).toContain("status: dropped");
	});

	test("a status the board has no column for is refused with the board's own list", async () => {
		await setup({ boardYaml: planning() });
		const t = await u.tasks.create({ title: "T" });
		const r = await act("set_status", {
			id: t.id,
			to: "draft",
			reason: "park it",
		});
		expect(r.status).toBe("rejected");
		expect(r.rejection?.code).toBe("status_unavailable");
		expect(r.rejection?.message).toContain("planned");
	});

	test("a spec on a one-file board is refused, not dropped", async () => {
		await setup({ boardYaml: planning() });
		const r = await act("create_tasks", {
			tasks: [spec("T", { spec: "# the spec" })],
		});
		expect(r.rejection?.code).toBe("spec_unsupported");
	});
});

describe("set_status", () => {
	test("done is not a status the brain can set", async () => {
		await setup();
		const t = await u.tasks.create({ title: "T", status: "ready" });
		const r = await act("set_status", { id: t.id, to: "done", reason: "x" });
		expect(r.status).toBe("rejected");
		expect(r.rejection?.code).toBe("invalid_args");
	});

	test("backlog parks a task and ready releases it", async () => {
		await setup();
		const t = await u.tasks.create({ title: "T", status: "ready" });
		await act("set_status", { id: t.id, to: "backlog", reason: "park" });
		expect(await u.tasks.get(t.id)).toMatchObject({
			status: "backlog",
			readyMode: "manual",
		});
		await act("set_status", { id: t.id, to: "ready", reason: "go" });
		expect(await u.tasks.get(t.id)).toMatchObject({
			status: "ready",
			readyMode: "automatic",
		});
	});
});

describe("split_task and merge_tasks", () => {
	test("split with archive: children carry split_from, the original is archived, dependents follow", async () => {
		await setup();
		const big = await u.tasks.create({
			title: "Big",
			status: "ready",
			owns: ["src/big/**"],
		});
		const later = await u.tasks.create({
			title: "Later",
			status: "backlog",
			dependsOn: [big.id],
		});
		const r = await act("split_task", {
			id: big.id,
			keep_original: "archive",
			into: [
				spec("Big part 1", { ref: "a", owns: ["src/big/a/**"] }),
				spec("Big part 2", { depends_on: ["a"], owns: ["src/big/b/**"] }),
			],
		});
		expect(r.status).toBe("applied");
		const ids = r.result?.ids as string[];
		expect(ids).toHaveLength(2);
		expect((await u.tasks.get(big.id))?.status).toBe("archived");
		for (const id of ids) {
			const c = await u.tasks.get(id);
			expect(c?.splitFromId).toBe(big.id);
			expect(c?.source).toBe("split");
		}
		expect([
			...((await u.tasks.get(later.id))?.dependsOn.sort() ?? []),
		]).toEqual([...ids].sort());
	});

	test("split with epic keeps the original as the parent", async () => {
		await setup();
		const big = await u.tasks.create({
			title: "Big",
			status: "ready",
			owns: ["src/big/**"],
		});
		const r = await act("split_task", {
			id: big.id,
			keep_original: "epic",
			into: [
				spec("Part 1", { owns: ["src/big/a/**"] }),
				spec("Part 2", { owns: ["src/big/b/**"] }),
			],
		});
		expect(r.status).toBe("applied");
		const orig = await u.tasks.get(big.id);
		expect(orig).toMatchObject({ type: "epic", status: "backlog", owns: [] });
		for (const id of r.result?.ids as string[]) {
			expect((await u.tasks.get(id))?.parentId).toBe(big.id);
		}
	});

	test("split is refused while the task runs, unless the live runs are to be stopped", async () => {
		await setup();
		const t = await u.tasks.create({ title: "Busy", status: "ready" });
		await act("spawn", { taskId: t.id, role: "implement" });
		for (const job of await u.runtime.executor.pendingSpawns()) {
			await u.runtime.executor.launch(job.actionId);
		}
		const r = await act("split_task", {
			id: t.id,
			keep_original: "archive",
			into: [spec("A"), spec("B")],
		});
		expect(r.rejection?.code).toBe("live_run");
	});

	test("merge: one new task, the originals archived and superseded, dependents rewired", async () => {
		await setup();
		const x = await u.tasks.create({ title: "X", status: "ready" });
		const a = await u.tasks.create({
			title: "A",
			status: "backlog",
			dependsOn: [x.id],
			owns: ["src/a/**"],
			priority: "low",
		});
		const b = await u.tasks.create({
			title: "B",
			status: "backlog",
			dependsOn: [x.id],
			owns: ["src/b/**"],
			priority: "high",
		});
		const dep = await u.tasks.create({
			title: "Dependent",
			status: "backlog",
			dependsOn: [a.id],
		});
		const r = await act("merge_tasks", {
			ids: [a.id, b.id],
			into: { title: "A and B" },
		});
		expect(r.status).toBe("applied");
		const [mergedId] = r.result?.ids as string[];
		const merged = await u.tasks.get(mergedId ?? "");
		expect(merged).toMatchObject({
			title: "A and B",
			priority: "high",
			dependsOn: [x.id],
		});
		expect([...(merged?.owns ?? [])].sort()).toEqual(["src/a/**", "src/b/**"]);
		for (const id of [a.id, b.id]) {
			expect(await u.tasks.get(id)).toMatchObject({
				status: "archived",
				supersededBy: mergedId,
			});
		}
		expect((await u.tasks.get(dep.id))?.dependsOn).toEqual([
			mergedId as string,
		]);
	});

	test("merge refuses a pair that would sit on a cycle once merged", async () => {
		await setup();
		const a = await u.tasks.create({ title: "A", status: "backlog" });
		const mid = await u.tasks.create({
			title: "Mid",
			status: "backlog",
			dependsOn: [a.id],
		});
		const b = await u.tasks.create({
			title: "B",
			status: "backlog",
			dependsOn: [mid.id],
		});
		const r = await act("merge_tasks", {
			ids: [a.id, b.id],
			into: { title: "AB" },
		});
		expect(r.status).toBe("rejected");
		expect(r.rejection?.code).toBe("dependency_cycle");
	});
});

describe("plan runs", () => {
	test("a draft is expanded by a plan-role spawn, once", async () => {
		await setup();
		const draft = await u.tasks.create({
			title: "do the thing",
			status: "draft",
			draftPrompt: "do the thing, carefully",
		});
		const r = await act("spawn", { taskId: draft.id, role: "plan" });
		expect(r.status).toBe("accepted");
		const fx = (r.result ?? {}) as { runIds?: string[] };
		expect(fx.runIds).toHaveLength(1);
		// accepted twice is refused: nothing is launched yet, but one is queued
		const again = await act("spawn", {
			taskId: draft.id,
			role: "plan",
			key: "again",
		});
		expect(again.rejection?.code).toBe("already_planning");

		const outcomes = [];
		for (const job of await u.runtime.executor.pendingSpawns()) {
			outcomes.push(await u.runtime.executor.launch(job.actionId));
		}
		expect(outcomes).toEqual([{ outcome: "applied", runIds: fx.runIds ?? [] }]);
		const start = u.effects.find((e) => e.tool === "startPlan");
		expect(start?.args[0]).toBe("do the thing, carefully");
		expect(start?.args[1]).toMatchObject({
			runId: fx.runIds?.[0],
			taskId: draft.id,
			originRef: `brain:${r.actionId}`,
		});
		// a second launch of the same action starts nothing
		expect(await u.runtime.executor.pendingSpawns()).toEqual([]);
		expect(u.effects.filter((e) => e.tool === "startPlan")).toHaveLength(1);
		// and the running plan makes another spawn a refusal with a reason
		const live = await act("spawn", {
			taskId: draft.id,
			role: "plan",
			key: "third",
		});
		expect(live.rejection?.code).toBe("already_planning");
	});

	test("a draft waiting for answers or past its attempts is not planned again", async () => {
		await setup();
		const draft = await u.tasks.create({ title: "x", status: "draft" });
		await u.tasks.recordDraftExpandFailure(draft.id, 1);
		const t = await u.tasks.get(draft.id);
		expect(t?.draftPhase).toBe("failed");
		const r = await act("spawn", { taskId: draft.id, role: "plan" });
		expect(r.rejection?.code).toBe("expansion_exhausted");
	});

	test("the digest names drafts that wait for a plan run", async () => {
		await setup();
		const draft = await u.tasks.create({ title: "x", status: "draft" });
		await u.human("anything");
		await u.advance(60_000);
		await u.endRun(turnRunId);
		await u.runtime.tick();
		const digest = u.launched.at(-1)?.prompt ?? "";
		expect(digest).toContain("Drafts waiting for a plan run");
		expect(digest).toContain(draft.id);
	});
});
