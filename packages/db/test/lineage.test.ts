import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { openProjectDb, type ProjectDbHandle } from "../src/client.ts";
import { backfillLineage, relationOf } from "../src/lineage-backfill.ts";
import {
	clarifications,
	type RunKind,
	runs,
	sessions,
	triggerDeliveries,
} from "../src/schema.ts";

async function withDb(
	fn: (h: ProjectDbHandle, dir: string) => Promise<void>,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-lineage-"));
	const h = await openProjectDb(dir);
	try {
		await fn(h, dir);
	} finally {
		h.close();
		await rm(dir, { recursive: true, force: true });
	}
}

let seq = 0;
/** A pre-lineage row: relation/chain_root_id/origin_ref are NULL. */
async function oldRun(
	h: ProjectDbHandle,
	id: string,
	kind: RunKind,
	label: string,
	over: { taskId?: string; parentRunId?: string } = {},
) {
	await h.db.insert(runs).values({
		id,
		kind,
		label,
		model: "m",
		cwd: "/tmp",
		startedAt: new Date(1_000_000 + seq++),
		...over,
	});
}

describe("relationOf", () => {
	test("maps kind, label suffix and parent to a relation", () => {
		const r = (kind: RunKind, label: string, parent?: string) =>
			relationOf({ kind, label, parentRunId: parent });
		expect(r("task", "T-1")).toBe("fresh");
		expect(r("task", "T-1", "p")).toBe("continue");
		expect(r("task", "T-1#repair", "p")).toBe("repair");
		expect(r("task", "T-1#resume", "p")).toBe("resume");
		expect(r("task", "T-1#answer", "p")).toBe("answer");
		expect(r("task", "T-1#unblock", "p")).toBe("unblock");
		expect(r("plan", "plan")).toBe("fresh");
		expect(r("plan", "plan#expand")).toBe("fresh");
		expect(r("plan", "plan#replan", "p")).toBe("replan");
		expect(r("brain", "critic:abc", "p")).toBe("judge");
		expect(r("repair", "recovery:inc-1")).toBe("recovery");
		expect(r("action", "session")).toBe("session");
		expect(r("action", "action")).toBe("fresh");
		expect(r("import", "import")).toBe("fresh");
	});
});

describe("lineage backfill", () => {
	async function seed(h: ProjectDbHandle) {
		// One task chain: root -> #repair -> #resume -> #answer -> #unblock.
		await oldRun(h, "t0", "task", "T-1", { taskId: "T-1" });
		await oldRun(h, "t1", "task", "T-1#repair", {
			taskId: "T-1",
			parentRunId: "t0",
		});
		await oldRun(h, "t2", "task", "T-1#resume", {
			taskId: "T-1",
			parentRunId: "t1",
		});
		await oldRun(h, "t3", "task", "T-1#answer", {
			taskId: "T-1",
			parentRunId: "t2",
		});
		await oldRun(h, "t4", "task", "T-1#unblock", {
			taskId: "T-1",
			parentRunId: "t3",
		});
		// A fresh re-dispatch of the same task: own chain.
		await oldRun(h, "t5", "task", "T-1", { taskId: "T-1" });
		// A task run whose parent was pruned: its own root.
		await oldRun(h, "t6", "task", "T-2#repair", {
			taskId: "T-2",
			parentRunId: "gone",
		});
		// Plans.
		await oldRun(h, "p0", "plan", "plan");
		await oldRun(h, "p1", "plan", "plan#replan", { parentRunId: "p0" });
		// Brain critic judging t0, regression recovery, session action, trigger action.
		await oldRun(h, "b0", "brain", "critic:t0", {
			taskId: "T-1",
			parentRunId: "t0",
		});
		await oldRun(h, "r0", "repair", "recovery:inc-7");
		await oldRun(h, "s0", "action", "session");
		await oldRun(h, "a0", "action", "action");
		await oldRun(h, "i0", "import", "import");
		await h.db.insert(sessions).values({
			id: "sess-1",
			source: "blocked",
			sourceKey: "T-1",
			title: "t",
			context: "c",
			createdAt: new Date(0),
			openedRunId: "s0",
		});
		await h.db.insert(triggerDeliveries).values({
			id: "del-1",
			defId: "d",
			eventSeq: 1,
			eventType: "task.created",
			startedAt: new Date(0),
			runId: "a0",
		});
		await h.db.insert(clarifications).values({
			runId: "p0",
			kind: "planner",
			items: [],
			continuationRunId: "p1",
			createdAt: new Date(0),
		});
	}

	test("derives relation, chain root and origin for old rows", async () => {
		await withDb(async (h) => {
			await seed(h);
			expect(await backfillLineage(h.db)).toBe(14);
			const rows = new Map(
				(await h.db.select().from(runs)).map((r) => [r.id, r]),
			);
			const rel = (id: string) => rows.get(id)?.relation;
			const root = (id: string) => rows.get(id)?.chainRootId;
			expect(rel("t0")).toBe("fresh");
			expect(rel("t1")).toBe("repair");
			expect(rel("t2")).toBe("resume");
			expect(rel("t3")).toBe("answer");
			expect(rel("t4")).toBe("unblock");
			for (const id of ["t0", "t1", "t2", "t3", "t4"])
				expect(root(id)).toBe("t0");
			expect(rel("t5")).toBe("fresh");
			expect(root("t5")).toBe("t5");
			expect(rel("t6")).toBe("repair");
			expect(root("t6")).toBe("t6");
			expect(rel("p0")).toBe("fresh");
			expect(rel("p1")).toBe("replan");
			expect(root("p1")).toBe("p1");
			expect(rel("b0")).toBe("judge");
			expect(root("b0")).toBe("b0");
			expect(rel("r0")).toBe("recovery");
			expect(rel("s0")).toBe("session");
			expect(rows.get("s0")?.originRef).toBe("session:sess-1");
			expect(rel("a0")).toBe("trigger");
			expect(rows.get("a0")?.originRef).toBe("trigger:del-1");
			expect(rows.get("p1")?.originRef).toBe("clarify:p0");
			expect(rel("i0")).toBe("fresh");
			expect(rows.get("i0")?.originRef).toBeNull();
		});
	});

	test("is idempotent: a second pass writes nothing and keeps values", async () => {
		await withDb(async (h) => {
			await seed(h);
			await backfillLineage(h.db);
			const before = await h.db.select().from(runs);
			expect(await backfillLineage(h.db)).toBe(0);
			expect(await h.db.select().from(runs)).toEqual(before);
		});
	});

	test("does not overwrite rows that already carry lineage", async () => {
		await withDb(async (h) => {
			await oldRun(h, "x1", "task", "T-9#repair", { taskId: "T-9" });
			await h.db
				.update(runs)
				.set({ relation: "attempt", chainRootId: "elsewhere" })
				.where(eq(runs.id, "x1"));
			await backfillLineage(h.db);
			const [row] = await h.db.select().from(runs).where(eq(runs.id, "x1"));
			expect(row?.relation).toBe("attempt");
			expect(row?.chainRootId).toBe("elsewhere");
		});
	});

	test("creates the parent and chain indexes", async () => {
		await withDb(async (h) => {
			const res = await h.client.execute(
				"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='runs'",
			);
			const names = res.rows.map((r) => r.name);
			expect(names).toContain("ix_runs_parent");
			expect(names).toContain("ix_runs_chain");
			// the planner uses it for the child lookup
			const plan = await h.db.all(
				sql`EXPLAIN QUERY PLAN SELECT id FROM runs WHERE parent_run_id = 'x'`,
			);
			expect(JSON.stringify(plan)).toContain("ix_runs_parent");
		});
	});

	test("reopening a db re-runs migrations and backfill without error", async () => {
		await withDb(async (h, dir) => {
			await oldRun(h, "z0", "task", "T-1", { taskId: "T-1" });
			h.close();
			const again = await openProjectDb(dir);
			try {
				const [row] = await again.db.select().from(runs);
				expect(row?.relation).toBe("fresh");
				expect(row?.chainRootId).toBe("z0");
			} finally {
				again.close();
			}
			// the outer finally closes `h` again; closing twice is harmless
		});
	});
});
