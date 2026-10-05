import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { triggerCursor } from "@mfw/db/schema";
import { silentLogger } from "../src/log.ts";
import type { TaskService } from "../src/task-service.ts";
import {
	TriggerActionRegistry,
	type TriggerActionResult,
} from "../src/triggers/actions.ts";
import { createCreateTaskAction } from "../src/triggers/create-task-action.ts";
import { loadTriggerDefs } from "../src/triggers/def.ts";
import { TriggerService } from "../src/triggers/service.ts";
import { makeTasks } from "./fixtures/board.ts";

// `cron:` sources and `action: create_task`. Exercises the shared `cronDue`
// check through the trigger pipeline (arming, cursor, retry/backoff, `on_failure`);
// `lifetime.test.ts` covers `LifetimeManager` directly.

interface F {
	root: string;
	home: string;
	handle: ProjectDbHandle;
	tasks: TaskService;
	svc: TriggerService;
	ran: { defId: string; deliveryId: string; seq: number }[];
	def: (name: string, body: string) => Promise<void>;
	cleanup: () => Promise<void>;
}

async function fixture(
	opts: { result?: () => TriggerActionResult; now?: () => number } = {},
): Promise<F> {
	const root = await mkdtemp(join(tmpdir(), "mfw-cron-"));
	const home = await mkdtemp(join(tmpdir(), "mfw-cron-home-"));
	const handle = await openProjectDb(join(root, ".mfw"));
	const bus = new EventBus();
	const tasks = await makeTasks(handle, bus, join(root, ".mfw"));
	const ran: F["ran"] = [];
	const actions = new TriggerActionRegistry();
	actions.register("create_task", createCreateTaskAction({ tasks }));
	actions.register("notify", async (d) => {
		ran.push({ defId: d.def.id, deliveryId: d.deliveryId, seq: d.event.seq });
		return opts.result ? opts.result() : { ok: true };
	});
	const svc = new TriggerService({
		handle,
		bus,
		log: silentLogger(),
		projectRoot: root,
		projectName: "demo",
		mfwHome: home,
		actions,
		now: opts.now,
	});
	return {
		root,
		home,
		handle,
		tasks,
		svc,
		ran,
		def: async (name, body) => {
			await mkdir(join(root, ".mfw", "triggers"), { recursive: true });
			await writeFile(join(root, ".mfw", "triggers", name), body);
		},
		cleanup: async () => {
			handle.close();
			await rm(root, { recursive: true, force: true });
			await rm(home, { recursive: true, force: true });
		},
	};
}

const NIGHTLY = `---
id: nightly-sweep
title: Nightly regression sweep
cron: "0 3 * * *"
action: create_task
type: maintenance
dedupe: skip_if_active
---

Runs the regression sweep every night at 3am.
`;

const NIGHTLY_NOTIFY = `---
id: nightly-sweep
title: Nightly regression sweep
cron: "0 3 * * *"
action: notify
message: fire
retries: 2
---

Runs the regression sweep every night at 3am.
`;

/** `bun test` forces UTC, so these `Z` timestamps match the cron field's local-time semantics. */
const AT_3AM = new Date("2026-08-09T03:00:30Z").getTime();
const AT_3AM_LATER = new Date("2026-08-09T03:00:50Z").getTime();
const AT_10AM = new Date("2026-08-09T10:00:00Z").getTime();

describe("the definition format: cron + create_task (MFW-33 item 2)", () => {
	test("cron + create_task round-trips through the loader", async () => {
		const f = await fixture();
		await f.def("nightly-sweep.md", NIGHTLY);
		const { defs, quarantined } = await loadTriggerDefs(
			join(f.root, ".mfw", "triggers"),
			silentLogger(),
		);
		expect(quarantined).toEqual([]);
		const def = defs[0];
		expect(def?.source).toEqual({ kind: "cron", schedule: "0 3 * * *" });
		expect(def?.action).toEqual({
			kind: "create_task",
			type: "maintenance",
			dedupe: "skip_if_active",
			dod: null,
		});
		await f.cleanup();
	});

	test("`on` and `cron` together is a quarantine, not a silent pick", async () => {
		const f = await fixture();
		await f.def(
			"bad.md",
			NIGHTLY.replace(
				'cron: "0 3 * * *"',
				'cron: "0 3 * * *"\non: merge.completed',
			),
		);
		const { defs, quarantined } = await loadTriggerDefs(
			join(f.root, ".mfw", "triggers"),
			silentLogger(),
		);
		expect(defs).toEqual([]);
		expect(quarantined[0]?.reason).toContain("mutually exclusive");
		await f.cleanup();
	});

	test("neither `on` nor `cron` is a quarantine", async () => {
		const f = await fixture();
		await f.def("bad.md", NIGHTLY.replace('cron: "0 3 * * *"\n', ""));
		const { quarantined } = await loadTriggerDefs(
			join(f.root, ".mfw", "triggers"),
			silentLogger(),
		);
		expect(quarantined[0]?.reason).toContain("either `on`");
		await f.cleanup();
	});

	test("an invalid cron expression is quarantined with a reason", async () => {
		const f = await fixture();
		await f.def("bad.md", NIGHTLY.replace('"0 3 * * *"', '"not a cron"'));
		const { quarantined } = await loadTriggerDefs(
			join(f.root, ".mfw", "triggers"),
			silentLogger(),
		);
		expect(quarantined[0]?.reason).toContain("invalid `cron`");
		await f.cleanup();
	});
});

describe("cron dispatch", () => {
	test("armed, it fires once at its scheduled minute and creates a task", async () => {
		const clock = AT_3AM;
		const f = await fixture({ now: () => clock });
		await f.def("nightly-sweep.md", NIGHTLY);
		await f.svc.arm("nightly-sweep");

		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 1, failed: 0 });
		const created = await f.tasks.list("backlog");
		expect(created.length).toBe(1);
		expect(created[0]?.source).toBe("lifetime");
		expect(created[0]?.lifetimeDefId).toBe("nightly-sweep");
		expect(created[0]?.title).toContain("Nightly regression sweep");
		await f.cleanup();
	});

	test("does not fire twice inside the same minute", async () => {
		let clock = AT_3AM;
		const f = await fixture({ now: () => clock });
		await f.def("nightly-sweep.md", NIGHTLY);
		await f.svc.arm("nightly-sweep");
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 1 });

		clock = AT_3AM_LATER;
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0 });
		expect((await f.tasks.list()).length).toBe(1);
		await f.cleanup();
	});

	test("a never-fired definition does not invent a backlog of past runs", async () => {
		const f = await fixture({ now: () => AT_10AM }); // arm off-schedule
		await f.def("nightly-sweep.md", NIGHTLY);
		await f.svc.arm("nightly-sweep");
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0 });
		expect((await f.tasks.list()).length).toBe(0);
		await f.cleanup();
	});

	test("arming DURING the scheduled minute still fires it, the arm-time marker is not mistaken for a prior fire", async () => {
		const f = await fixture({ now: () => AT_3AM });
		await f.def("nightly-sweep.md", NIGHTLY);
		await f.svc.arm("nightly-sweep"); // armed at the exact matching minute
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 1 });
		expect((await f.tasks.list()).length).toBe(1);
		await f.cleanup();
	});

	test("a MISSED occurrence is caught up once after downtime", async () => {
		// Catch-up compares against the last real fire, so seed one.
		let clock = new Date("2026-08-08T03:00:00Z").getTime();
		const f = await fixture({ now: () => clock });
		await f.def("nightly-sweep.md", NIGHTLY);
		await f.svc.arm("nightly-sweep");
		await f.svc.dispatch();
		const firstId = (await f.tasks.list())[0]?.id as string;
		await f.tasks.move(firstId, "done", "scheduler");

		// Daemon was down through 3am; wakes at 10am.
		clock = AT_10AM;
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 1 });
		expect((await f.tasks.list("backlog")).length).toBe(1);
		await f.cleanup();
	});

	test("catch-up fires ONCE, not once per missed day", async () => {
		let clock = new Date("2026-08-01T03:00:00Z").getTime();
		const f = await fixture({ now: () => clock });
		await f.def("nightly-sweep.md", NIGHTLY);
		await f.svc.arm("nightly-sweep");
		await f.svc.dispatch();
		await f.tasks.move(
			(await f.tasks.list())[0]?.id as string,
			"done",
			"scheduler",
		);

		clock = new Date("2026-08-09T10:00:00Z").getTime(); // over a week missed
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 1 });
		expect((await f.tasks.list("backlog")).length).toBe(1);
		await f.cleanup();
	});

	test("`catchup: none` skips a miss silently to the trigger, loudly to the record", async () => {
		let clock = new Date("2026-08-08T03:00:00Z").getTime();
		const f = await fixture({ now: () => clock, result: () => ({ ok: true }) });
		await f.def(
			"nightly-sweep.md",
			NIGHTLY.replace(
				"dedupe: skip_if_active",
				"dedupe: skip_if_active\ncatchup: none",
			),
		);
		await f.svc.arm("nightly-sweep");
		await f.svc.dispatch(); // a real first fire
		await f.tasks.move(
			(await f.tasks.list())[0]?.id as string,
			"done",
			"scheduler",
		);

		clock = AT_10AM; // missed today's occurrence
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0, skipped: 1 });
		expect((await f.tasks.list("backlog")).length).toBe(0);
		const [row] = await f.svc.deliveries("nightly-sweep");
		expect(row?.state).toBe("skipped");
		await f.cleanup();
	});

	test("`dedupe: skip_if_active` does not stack instances while one is open", async () => {
		let clock = AT_3AM;
		const f = await fixture({ now: () => clock });
		await f.def("nightly-sweep.md", NIGHTLY);
		await f.svc.arm("nightly-sweep");
		await f.svc.dispatch();
		expect((await f.tasks.list()).length).toBe(1);

		// Task still open; the next occurrence must not create a second.
		clock = new Date("2026-08-10T03:00:10Z").getTime();
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 1 }); // the action ran...
		expect((await f.tasks.list()).length).toBe(1); // ...but skipped creating
		await f.cleanup();
	});

	test("a retry on a cron trigger pins to the SAME firing, not a fresh one", async () => {
		let clock = AT_3AM;
		let calls = 0;
		const f = await fixture({
			now: () => clock,
			result: () => {
				calls++;
				return { ok: false, detail: `boom ${calls}` };
			},
		});
		await f.def("nightly-sweep.md", NIGHTLY_NOTIFY);
		await f.svc.arm("nightly-sweep");

		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0, failed: 1 });
		// Not terminal (retries left): the cursor must not pass this firing.
		const cursorRow = () =>
			f.handle.db
				.select()
				.from(triggerCursor)
				.then((rows) => rows[0]);
		expect((await cursorRow())?.lastSeq).not.toBe(AT_3AM);
		let [row] = await f.svc.deliveries("nightly-sweep");
		expect(row?.eventSeq).toBe(AT_3AM);

		// Cooling down: retry reuses AT_3AM and makes no call yet.
		clock += 1_000;
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0, failed: 0 });
		expect(calls).toBe(1);

		clock += 10_000; // past backoff
		expect(await f.svc.dispatch()).toMatchObject({ dispatched: 0, failed: 1 });
		[row] = await f.svc.deliveries("nightly-sweep");
		expect(row?.eventSeq).toBe(AT_3AM); // still the original firing
		expect(row?.attempt).toBe(2);
		await f.cleanup();
	});
});

describe("action: create_task", () => {
	test("dedupe: always creates one task per firing, even while the last is open", async () => {
		let clock = AT_3AM;
		const f = await fixture({ now: () => clock });
		await f.def(
			"nightly-sweep.md",
			NIGHTLY.replace("dedupe: skip_if_active", "dedupe: always"),
		);
		await f.svc.arm("nightly-sweep");
		await f.svc.dispatch();

		clock = new Date("2026-08-10T03:00:10Z").getTime();
		await f.svc.dispatch();
		expect((await f.tasks.list()).length).toBe(2);
		await f.cleanup();
	});
});
