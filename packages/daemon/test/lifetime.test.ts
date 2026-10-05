import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { lifetimeState } from "@mfw/db/schema";
import { LifetimeManager } from "../src/lifetime.ts";
import { silentLogger } from "../src/log.ts";
import type { TaskService } from "../src/task-service.ts";
import { makeTasks } from "./fixtures/board.ts";

interface F {
	root: string;
	handle: ProjectDbHandle;
	tasks: TaskService;
	life: LifetimeManager;
	def: (name: string, body: string) => Promise<void>;
	cleanup: () => Promise<void>;
}

async function fixture(
	conditions?: Record<string, (root: string) => Promise<boolean>>,
): Promise<F> {
	const root = await mkdtemp(join(tmpdir(), "mfw-life-"));
	const mfwDir = join(root, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const tasks = await makeTasks(handle, bus, mfwDir);
	const life = new LifetimeManager({
		handle,
		bus,
		tasks,
		log: silentLogger(),
		projectRoot: root,
		conditions,
	});
	return {
		root,
		handle,
		tasks,
		life,
		def: async (name, body) => {
			await mkdir(join(mfwDir, "lifetime"), { recursive: true });
			await writeFile(join(mfwDir, "lifetime", name), body);
		},
		cleanup: async () => {
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

const DAILY_3AM = `---
id: doc-sync
title: Keep the docs in sync with the code
type: maintenance
trigger:
  schedule: "0 3 * * *"
dedupe: skip_if_active
---

Diff the docs against the current API surface and update them.
`;

/** 03:00 on a fixed day, the scheduled minute. */
const AT_3AM = new Date("2026-08-09T03:00:30Z");
const AT_3AM_LATER = new Date("2026-08-09T03:00:50Z");
const AT_10AM = new Date("2026-08-09T10:00:00Z");
const NEXT_DAY_10AM = new Date("2026-08-10T10:00:00Z");

describe("lifetime firing", () => {
	test("fires on its scheduled minute and creates a backlog task with lineage", async () => {
		const f = await fixture();
		await f.def("doc-sync.md", DAILY_3AM);

		const r = await f.life.tick(AT_3AM);
		expect(r[0]?.reason).toBe("fired");
		const taskId = r[0]?.taskId as string;
		const task = await f.tasks.get(taskId);
		expect(task?.status).toBe("backlog"); // never runs inline
		expect(task?.source).toBe("lifetime");
		expect(task?.lifetimeDefId).toBe("doc-sync"); // lineage is recorded
		expect(task?.title).toContain("docs in sync");
		await f.cleanup();
	});

	test("does not fire twice inside the same minute", async () => {
		const f = await fixture();
		await f.def("doc-sync.md", DAILY_3AM);
		expect((await f.life.tick(AT_3AM))[0]?.reason).toBe("fired");
		// dedupe is skip_if_active, so also prove the same-minute guard by
		// completing the task first
		const first = await f.tasks.list("backlog");
		await f.tasks.move(first[0]?.id as string, "done", "scheduler");
		expect((await f.life.tick(AT_3AM_LATER))[0]?.reason).toBe("not-due");
		await f.cleanup();
	});

	test("skip_if_active does not stack instances while one is open", async () => {
		const f = await fixture();
		await f.def("doc-sync.md", DAILY_3AM);
		await f.life.tick(AT_3AM);
		// next day's occurrence, previous task still open
		const r = await f.life.tick(new Date("2026-08-10T03:00:10Z"));
		expect(r[0]?.reason).toBe("skipped-active");
		expect((await f.tasks.list()).length).toBe(1);
		await f.cleanup();
	});

	test("MISSED occurrences are caught up after downtime: v1 dropped them", async () => {
		const f = await fixture();
		await f.def("doc-sync.md", DAILY_3AM);
		// It fired yesterday...
		await f.life.tick(new Date("2026-08-08T03:00:00Z"));
		const firstId = (await f.tasks.list())[0]?.id as string;
		await f.tasks.move(firstId, "done", "scheduler");

		// ...the daemon was down at 03:00 today, and only wakes at 10:00.
		const r = await f.life.tick(AT_10AM);
		expect(r[0]?.reason).toBe("caught-up");
		expect((await f.tasks.list("backlog")).length).toBe(1);
		await f.cleanup();
	});

	test("catch-up fires ONCE, not once per missed occurrence", async () => {
		// A week of downtime must not spawn a week of tasks.
		const f = await fixture();
		await f.def("doc-sync.md", DAILY_3AM);
		await f.life.tick(new Date("2026-08-01T03:00:00Z"));
		await f.tasks.move(
			(await f.tasks.list())[0]?.id as string,
			"done",
			"scheduler",
		);

		const r = await f.life.tick(new Date("2026-08-09T10:00:00Z"));
		expect(r[0]?.reason).toBe("caught-up");
		expect((await f.tasks.list("backlog")).length).toBe(1);
		await f.cleanup();
	});

	test("a never-fired definition does not invent a backlog of past runs", async () => {
		const f = await fixture();
		await f.def("doc-sync.md", DAILY_3AM);
		const r = await f.life.tick(AT_10AM); // off-schedule, never fired before
		expect(r[0]?.reason).toBe("not-due");
		expect((await f.tasks.list()).length).toBe(0);
		await f.cleanup();
	});

	test("firing state is DURABLE: a restart does not re-fire", async () => {
		const f = await fixture();
		await f.def("doc-sync.md", DAILY_3AM);
		await f.life.tick(AT_3AM);
		const [row] = await f.handle.db.select().from(lifetimeState);
		expect(row?.defId).toBe("doc-sync");
		expect(row?.lastTaskId).toBeTruthy();

		// a fresh manager over the same DB (as a restart would build)
		const restarted = new LifetimeManager({
			handle: f.handle,
			bus: new EventBus(),
			tasks: f.tasks,
			log: silentLogger(),
			projectRoot: f.root,
		});
		await f.tasks.move(
			(await f.tasks.list())[0]?.id as string,
			"done",
			"scheduler",
		);
		expect((await restarted.tick(AT_3AM_LATER))[0]?.reason).toBe("not-due");
		await f.cleanup();
	});
});

describe("lifetime edge cases", () => {
	test("one malformed definition never stops the others", async () => {
		const f = await fixture();
		await f.def("broken.md", "not: [valid: yaml: at all\n");
		await f.def("doc-sync.md", DAILY_3AM);
		const r = await f.life.tick(AT_3AM);
		// the good one still fired
		expect(r.some((x) => x.defId === "doc-sync" && x.reason === "fired")).toBe(
			true,
		);
		await f.cleanup();
	});

	test("an id violating the grammar is rejected, not silently minted", async () => {
		const f = await fixture();
		await f.def(
			"bad.md",
			`---\nid: Not_A_Valid_ID\ntitle: x\ntrigger:\n  schedule: "0 3 * * *"\n---\nbody\n`,
		);
		const r = await f.life.tick(AT_3AM);
		expect(r.length).toBe(0);
		expect((await f.tasks.list()).length).toBe(0);
		await f.cleanup();
	});

	test("condition triggers fire when their predicate holds", async () => {
		let stale = false;
		const f = await fixture({ docs_older_than_code: async () => stale });
		await f.def(
			"docs.md",
			`---\nid: docs-stale\ntitle: Refresh the docs\ntrigger:\n  condition: docs_older_than_code\n---\nbody\n`,
		);
		expect((await f.life.tick(AT_10AM))[0]?.reason).toBe("not-due");
		stale = true;
		expect((await f.life.tick(NEXT_DAY_10AM))[0]?.reason).toBe("fired");
		await f.cleanup();
	});

	test("an unknown condition is quarantined at load, not silently never-firing (MFW-22)", async () => {
		const f = await fixture();
		await f.def(
			"x.md",
			`---\nid: mystery\ntitle: x\ntrigger:\n  condition: no_such_predicate\n---\nbody\n`,
		);
		const r = await f.life.tick(AT_10AM);
		expect(r.length).toBe(0);
		expect((await f.tasks.list()).length).toBe(0);
		await f.cleanup();
	});
});
