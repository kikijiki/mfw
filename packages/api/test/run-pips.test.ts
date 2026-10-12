import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { type RunState, runs } from "@mfw/db/schema";
import { createCaller } from "../src/root.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
	for (const c of cleanups) await c();
});

type RunInsert = typeof runs.$inferInsert;

function run(
	id: string,
	taskId: string | null,
	at: number,
	state: RunState,
	over: Partial<RunInsert> = {},
): RunInsert {
	return {
		id,
		kind: "task",
		taskId,
		label: id,
		model: "sonnet",
		cwd: "/w",
		state,
		startedAt: new Date(1_000_000 + at),
		...over,
	};
}

async function fixture(rows: RunInsert[]) {
	const dir = await mkdtemp(join(tmpdir(), "mfw-pips-"));
	const handle: ProjectDbHandle = await openProjectDb(dir);
	cleanups.push(async () => {
		handle.close();
		await rm(dir, { recursive: true, force: true });
	});
	if (rows.length > 0) await handle.db.insert(runs).values(rows);
	const svc = { name: "demo", handle } as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	/** Statements the libsql client executes while `fn` runs. */
	const countQueries = async <T>(fn: () => Promise<T>) => {
		let n = 0;
		const client = handle.client;
		const execute = client.execute.bind(client);
		const batch = client.batch.bind(client);
		client.execute = ((...a: Parameters<typeof execute>) => {
			n++;
			return execute(...a);
		}) as typeof client.execute;
		client.batch = ((...a: Parameters<typeof batch>) => {
			n++;
			return batch(...a);
		}) as typeof client.batch;
		try {
			return { value: await fn(), queries: n };
		} finally {
			client.execute = execute;
			client.batch = batch;
		}
	};
	return { caller: createCaller({ orchestrator }), countQueries };
}

describe("runs.pipsByTask", () => {
	test("glyphs follow the settled state, oldest first, per task, task runs only", async () => {
		const f = await fixture([
			run("a1", "T-1", 1, "failed"),
			run("a2", "T-1", 2, "killed"),
			run("a3", "T-1", 3, "interrupted"),
			run("a4", "T-1", 4, "rate_limited"),
			run("a5", "T-1", 5, "finalize_error"),
			run("a6", "T-1", 6, "completed"),
			// not settled yet: no pip
			run("a7", "T-1", 7, "running"),
			run("a8", "T-1", 8, "merging"),
			// not a task run: no pip
			run("r1", "T-1", 9, "failed", { kind: "repair" }),
			run("b1", "T-2", 1, "completed"),
			run("n1", null, 1, "completed"),
		]);
		const pips = await f.caller.runs.pipsByTask({ project: "demo" });
		expect(pips).toEqual({
			"T-1": [
				{ ref: "run:a1", glyph: "fail" },
				{ ref: "run:a2", glyph: "stopped" },
				{ ref: "run:a3", glyph: "stopped" },
				{ ref: "run:a4", glyph: "rate" },
				{ ref: "run:a5", glyph: "fail" },
				{ ref: "run:a6", glyph: "ok" },
			],
			"T-2": [{ ref: "run:b1", glyph: "ok" }],
		});
	});

	test("at most 12 per task, keeping the newest, still oldest first", async () => {
		const rows = Array.from({ length: 15 }, (_, i) =>
			run(`c${String(i).padStart(2, "0")}`, "T-1", i, "completed"),
		);
		const f = await fixture(rows);
		const pips = await f.caller.runs.pipsByTask({ project: "demo" });
		expect(pips["T-1"]?.map((p) => p.ref)).toEqual(
			rows.slice(3).map((r) => `run:${r.id}`),
		);
	});

	test("one SQL query for the whole board, and taskIds narrows it", async () => {
		const rows: RunInsert[] = [];
		for (let t = 0; t < 30; t++) {
			for (let i = 0; i < 3; i++) {
				rows.push(run(`t${t}r${i}`, `T-${t}`, i, "completed"));
			}
		}
		const f = await fixture(rows);
		const all = await f.countQueries(() =>
			f.caller.runs.pipsByTask({ project: "demo" }),
		);
		expect(all.queries).toBe(1);
		expect(Object.keys(all.value)).toHaveLength(30);

		const some = await f.countQueries(() =>
			f.caller.runs.pipsByTask({ project: "demo", taskIds: ["T-3", "T-4"] }),
		);
		expect(some.queries).toBe(1);
		expect(Object.keys(some.value).sort()).toEqual(["T-3", "T-4"]);
	});
});
