import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { ulid } from "@mfw/db/ids";
import { engineKv, mergeJobs, type RunState, runs } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { InboxService } from "../src/inbox.ts";
import { silentLogger } from "../src/log.ts";
import { RunRegistry } from "../src/run-registry.ts";
import { SessionService } from "../src/session.ts";
import type { TaskService } from "../src/task-service.ts";
import { makeTasks } from "./fixtures/board.ts";

interface F {
	root: string;
	handle: ProjectDbHandle;
	tasks: TaskService;
	setMainRed: (causeTaskId?: string) => Promise<void>;
	cleanup: () => Promise<void>;
}

async function fixture(): Promise<F> {
	const root = await mkdtemp(join(tmpdir(), "mfw-inbox-"));
	const handle = await openProjectDb(join(root, ".mfw"));
	const bus = new EventBus();
	const tasks = await makeTasks(handle, bus, join(root, ".mfw"));
	return {
		root,
		handle,
		tasks,
		setMainRed: async (causeTaskId?: string) => {
			await handle.db.insert(engineKv).values({
				key: "main_red",
				value: { red: true, since: Date.now(), causeTaskId },
				updatedAt: new Date(),
			});
		},
		cleanup: async () => {
			handle.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** The `main_red` item says whether mfw is already repairing itself or a human is needed. */
describe("inbox: main_red self-repair disclosure", () => {
	test("self-repair off: unchanged wording, waits on a human", async () => {
		const f = await fixture();
		const cause = await f.tasks.create({ title: "broke it" });
		await f.setMainRed(cause.id);

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			selfRepairMainRed: () => false,
		});
		const item = (await inbox.list()).find((i) => i.kind === "main_red");
		expect(item?.detail).toBe(`merges are paused; broken by ${cause.id}`);
		await f.cleanup();
	});

	test("self-repair on, cause task in_progress: says mfw is repairing itself", async () => {
		const f = await fixture();
		const cause = await f.tasks.create({ title: "broke it" });
		await f.tasks.move(cause.id, "ready", "human");
		await f.tasks.tryClaim(cause.id, "01RUNPLACEHOLDER0000000000", 60_000);
		await f.setMainRed(cause.id);

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			selfRepairMainRed: () => true,
		});
		const item = (await inbox.list()).find((i) => i.kind === "main_red");
		expect(item?.detail).toContain("repairing itself");
		expect(item?.detail).toContain(cause.id);
		await f.cleanup();
	});

	test("self-repair on, cause task ready: says the repair is queued", async () => {
		const f = await fixture();
		const cause = await f.tasks.create({ title: "broke it" });
		await f.tasks.move(cause.id, "ready", "human");
		await f.setMainRed(cause.id);

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			selfRepairMainRed: () => true,
		});
		const item = (await inbox.list()).find((i) => i.kind === "main_red");
		expect(item?.detail).toContain("queued");
		await f.cleanup();
	});

	test("self-repair on, cause task blocked past its stall cap: needs a human, plainly", async () => {
		const f = await fixture();
		const cause = await f.tasks.create({ title: "broke it" });
		await f.tasks.move(cause.id, "blocked", "verifier", "stall cap");
		await f.setMainRed(cause.id);

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			selfRepairMainRed: () => true,
		});
		const item = (await inbox.list()).find((i) => i.kind === "main_red");
		expect(item?.detail).toContain("self-repair failed");
		expect(item?.detail).toContain("needs a human");
		await f.cleanup();
	});

	// `escalated` outranks the self-repair disclosure: it must not claim "repairing itself".
	test("escalated: needs a human, regardless of self-repair or the cause task's status", async () => {
		const f = await fixture();
		const cause = await f.tasks.create({ title: "never gets fixed" });
		await f.tasks.move(cause.id, "ready", "human");
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: {
				red: true,
				since: Date.now(),
				causeTaskId: cause.id,
				escalated: true,
			},
			updatedAt: new Date(),
		});

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			selfRepairMainRed: () => true,
		});
		const item = (await inbox.list()).find((i) => i.kind === "main_red");
		expect(item?.title).toContain("stalled");
		expect(item?.detail).toContain("needs a human");
		expect(item?.detail).not.toContain("repairing itself");
		await f.cleanup();
	});
});

describe("inbox: sweep infra failure (MFW-37)", () => {
	test("a corroborated infra failure surfaces its own item, distinct from main_red", async () => {
		const f = await fixture();
		await f.handle.db.insert(engineKv).values({
			key: "sweep_infra",
			value: {
				active: true,
				since: Date.now(),
				attempts: 1,
				taskIds: ["MFW-1"],
				detail: "checks fail the same way at the last known-good commit",
			},
			updatedAt: new Date(),
		});

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		const item = (await inbox.list()).find((i) => i.kind === "sweep_infra");
		// Below the escalation threshold the sweep retries on its own: info, not attention.
		expect(item?.severity).toBe("info");
		expect(item?.detail).toContain("last known-good commit");
		await f.cleanup();
	});

	test("a persistent infra failure escalates to critical", async () => {
		const f = await fixture();
		await f.handle.db.insert(engineKv).values({
			key: "sweep_infra",
			value: {
				active: true,
				since: Date.now(),
				attempts: 3,
				taskIds: ["MFW-1"],
				detail: "checks fail the same way at the last known-good commit",
			},
			updatedAt: new Date(),
		});

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		const item = (await inbox.list()).find((i) => i.kind === "sweep_infra");
		expect(item?.severity).toBe("critical");
		await f.cleanup();
	});

	test("an inactive infra state produces no item", async () => {
		const f = await fixture();
		await f.handle.db.insert(engineKv).values({
			key: "sweep_infra",
			value: { active: false, since: 0, attempts: 0, taskIds: [], detail: "" },
			updatedAt: new Date(),
		});

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		expect(
			(await inbox.list()).find((i) => i.kind === "sweep_infra"),
		).toBeUndefined();
		await f.cleanup();
	});
});

/**
 * MFW-50: approving a task enqueues a merge job but never marks the task
 * itself, it only leaves `review` once the merge lands. Without this filter
 * a task whose merge is queued or in flight looks exactly like one nobody has
 * looked at yet, and the review tab keeps re-offering a decision that was
 * already made.
 */
describe("inbox: review items suppressed while a merge is in flight (MFW-50)", () => {
	test("a task in review with a queued merge job is not offered as a decision", async () => {
		const f = await fixture();
		const task = await f.tasks.create({ title: "ship it" });
		await f.tasks.move(task.id, "review", "human");

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			mergeQueue: {
				activeByTask: async () => [{ taskId: task.id }],
			},
		});
		expect((await inbox.list()).map((i) => i.kind)).not.toContain("review");
		await f.cleanup();
	});

	test("a task in review with no active merge job is still offered", async () => {
		const f = await fixture();
		const task = await f.tasks.create({ title: "ship it" });
		await f.tasks.move(task.id, "review", "human");

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			mergeQueue: { activeByTask: async () => [] },
		});
		const item = (await inbox.list()).find((i) => i.kind === "review");
		expect(item?.taskId).toBe(task.id);
		await f.cleanup();
	});
});

/** Minimal `runs` row (NOT NULL columns only) for FK / taskId joins. */
async function insertRun(
	handle: ProjectDbHandle,
	opts: { id?: string; taskId?: string | null; state?: RunState } = {},
): Promise<string> {
	const id = opts.id ?? ulid();
	await handle.db.insert(runs).values({
		id,
		kind: "task",
		taskId: opts.taskId ?? null,
		label: "run",
		model: "sonnet",
		cwd: "/tmp",
		state: opts.state ?? "starting",
		startedAt: new Date(),
	});
	return id;
}

/** A `blocked` task has exhausted every automatic remedy (like an exhausted `merge_parked`), so it is critical. */
describe("inbox: blocked severity (MFW-52)", () => {
	test("a blocked task is critical, not merely attention", async () => {
		const f = await fixture();
		const task = await f.tasks.create({ title: "stuck" });
		await f.tasks.move(task.id, "blocked", "scheduler", "repairs exhausted");

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		const item = (await inbox.list()).find((i) => i.kind === "blocked");
		expect(item?.severity).toBe("critical");
		await f.cleanup();
	});
});

/** While self-repair is working the cause (running or queued) the item is informational; critical once nothing is happening. */
describe("inbox: main_red severity follows what's actually happening (MFW-52)", () => {
	test("self-repair off: critical: nothing is happening automatically", async () => {
		const f = await fixture();
		const cause = await f.tasks.create({ title: "broke it" });
		await f.setMainRed(cause.id);

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			selfRepairMainRed: () => false,
		});
		const item = (await inbox.list()).find((i) => i.kind === "main_red");
		expect(item?.severity).toBe("critical");
		await f.cleanup();
	});

	test("self-repair on, cause task in_progress: info: mfw is already on it", async () => {
		const f = await fixture();
		const cause = await f.tasks.create({ title: "broke it" });
		await f.tasks.move(cause.id, "ready", "human");
		await f.tasks.tryClaim(cause.id, "01RUNPLACEHOLDER0000000000", 60_000);
		await f.setMainRed(cause.id);

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			selfRepairMainRed: () => true,
		});
		const item = (await inbox.list()).find((i) => i.kind === "main_red");
		expect(item?.severity).toBe("info");
		await f.cleanup();
	});

	test("self-repair on, cause task ready: info: repair is queued", async () => {
		const f = await fixture();
		const cause = await f.tasks.create({ title: "broke it" });
		await f.tasks.move(cause.id, "ready", "human");
		await f.setMainRed(cause.id);

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			selfRepairMainRed: () => true,
		});
		const item = (await inbox.list()).find((i) => i.kind === "main_red");
		expect(item?.severity).toBe("info");
		await f.cleanup();
	});

	test("self-repair on, cause task blocked past its stall cap: critical", async () => {
		const f = await fixture();
		const cause = await f.tasks.create({ title: "broke it" });
		await f.tasks.move(cause.id, "blocked", "verifier", "stall cap");
		await f.setMainRed(cause.id);

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			selfRepairMainRed: () => true,
		});
		const item = (await inbox.list()).find((i) => i.kind === "main_red");
		expect(item?.severity).toBe("critical");
		await f.cleanup();
	});

	test("escalated: critical, regardless of self-repair or the cause task's status", async () => {
		const f = await fixture();
		const cause = await f.tasks.create({ title: "never gets fixed" });
		await f.tasks.move(cause.id, "ready", "human");
		await f.handle.db.insert(engineKv).values({
			key: "main_red",
			value: {
				red: true,
				since: Date.now(),
				causeTaskId: cause.id,
				escalated: true,
			},
			updatedAt: new Date(),
		});

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			selfRepairMainRed: () => true,
		});
		const item = (await inbox.list()).find((i) => i.kind === "main_red");
		expect(item?.severity).toBe("critical");
		await f.cleanup();
	});
});

/** MergeQueue retries parks automatically (see `merge-queue.test.ts`); the inbox must not surface one still within budget. */
describe("inbox: merge_parked only surfaces once retries are exhausted (MFW-52)", () => {
	test("a park below the retry budget produces no item", async () => {
		const f = await fixture();
		const runId = await insertRun(f.handle);
		await f.handle.db.insert(mergeJobs).values({
			runId,
			branch: "mfw/t1",
			targetBranch: "main",
			state: "parked",
			parkRetries: 1,
			error: "rebase conflict: ...",
			enqueuedAt: new Date(),
			updatedAt: new Date(),
		});

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		expect(
			(await inbox.list()).find((i) => i.kind === "merge_parked"),
		).toBeUndefined();
		await f.cleanup();
	});

	test("a park past the retry budget surfaces, critical, with the retry count in the detail", async () => {
		const f = await fixture();
		const runId = await insertRun(f.handle);
		await f.handle.db.insert(mergeJobs).values({
			runId,
			branch: "mfw/t1",
			targetBranch: "main",
			state: "parked",
			parkRetries: 3,
			error:
				"rebase conflict: ...; mfw retried this automatically 3 times and could not resolve it; it needs a human",
			enqueuedAt: new Date(),
			updatedAt: new Date(),
		});

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		const item = (await inbox.list()).find((i) => i.kind === "merge_parked");
		expect(item?.severity).toBe("critical");
		expect(item?.detail).toContain("retried this automatically 3 times");
		await f.cleanup();
	});
});

/** A failed run belonging to a task is already represented by the task's status; a separate `failed_run` item would never clear. */
describe("inbox: failed_run folds into the task, not beside it (MFW-52)", () => {
	test("unconfirmed process cleanup remains visible while holding the task", async () => {
		const f = await fixture();
		try {
			const task = await f.tasks.create({
				title: "writer cleanup",
				status: "ready",
			});
			const registry = new RunRegistry({
				handle: f.handle,
				bus: new EventBus(),
				runsDir: join(f.root, ".mfw/runs"),
			});
			const run = await registry.create({
				kind: "task",
				taskId: task.id,
				label: task.id,
				model: "sonnet",
				cwd: f.root,
			});
			await f.tasks.tryClaim(task.id, run.id, 60_000);
			await registry.beginStep(run.id, "reap_leftovers");
			await registry.failStep(run.id, "reap_leftovers", "writer remains live");
			await registry.transition(run.id, "finalize_error", {
				finishedAt: new Date(),
				note: "writer remains live",
			});
			const inbox = new InboxService({
				handle: f.handle,
				project: "demo",
				tasks: f.tasks,
			});
			expect(
				(await inbox.list()).find((item) => item.runId === run.id),
			).toMatchObject({
				kind: "failed_run",
				taskId: task.id,
				detail: "writer remains live",
			});
		} finally {
			await f.cleanup();
		}
	});

	test("a failed run with a task produces no separate item", async () => {
		const f = await fixture();
		const task = await f.tasks.create({ title: "flaky" });
		const runId = await insertRun(f.handle, {
			taskId: task.id,
			state: "failed",
		});
		await f.handle.db
			.update(runs)
			.set({ finishedAt: new Date(), note: "no DoD" })
			.where(eq(runs.id, runId));

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		expect(
			(await inbox.list()).find((i) => i.kind === "failed_run"),
		).toBeUndefined();
		await f.cleanup();
	});

	test("a failed run with no task (an import) still produces an item", async () => {
		const f = await fixture();
		const runId = await insertRun(f.handle, { taskId: null, state: "failed" });
		await f.handle.db
			.update(runs)
			.set({ finishedAt: new Date(), note: "importer proposed nothing" })
			.where(eq(runs.id, runId));

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		const item = (await inbox.list()).find((i) => i.kind === "failed_run");
		expect(item?.runId).toBe(runId);
		expect(item?.severity).toBe("info");
		await f.cleanup();
	});
});

describe("inbox: failed draft expansion", () => {
	test("queued and retrying drafts are autonomous work, not inbox work", async () => {
		const f = await fixture();
		await f.tasks.captureQuick("do the thing");
		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		expect(
			(await inbox.list()).find((i) => i.kind === "draft_failed"),
		).toBeUndefined();
		const draft = (await f.tasks.list()).find(
			(task) => task.status === "draft",
		);
		if (!draft) throw new Error("missing draft");
		await f.tasks.recordDraftExpandFailure(draft.id, 3);
		expect(
			(await inbox.list()).find((i) => i.kind === "draft_failed"),
		).toBeUndefined();
		await f.cleanup();
	});

	test("a draft whose retries are exhausted surfaces at attention", async () => {
		const f = await fixture();
		const draft = await f.tasks.captureQuick("do the thing");
		await f.tasks.recordDraftExpandFailure(draft.id, 1, {
			verifier: "deterministic",
			checks: [{ diff_against_base: true }],
		});

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		const item = (await inbox.list()).find((i) => i.kind === "draft_failed");
		expect(item?.taskId).toBe(draft.id);
		expect(item?.severity).toBe("attention");
		expect(item?.detail).toContain("1 expansion attempt");
		await f.cleanup();
	});

	test("editing the draft clears the exhausted inbox item", async () => {
		const f = await fixture();
		const draft = await f.tasks.captureQuick("do the thing");
		await f.tasks.recordDraftExpandFailure(draft.id, 1);
		await f.tasks.edit(draft.id, { body: "corrected prompt" });

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		expect(
			(await inbox.list()).find((i) => i.kind === "draft_failed"),
		).toBeUndefined();
		await f.cleanup();
	});
});

/**
 * `main_red` sessions do not auto-resolve, so a stale one can stay open when a
 * new regression trips main_red. Both `SessionService.itemId()` and
 * `InboxService.collect()` therefore key the inbox row on the specific cause;
 * a project-wide id would let dismissing the stale session hide the live incident.
 */
describe("inbox: main_red session dismissal is scoped to its own incident", () => {
	test("dismissing a stale session for an OLD cause does not hide the CURRENT, unrelated main_red incident", async () => {
		const f = await fixture();
		const causeX = await f.tasks.create({ title: "old regression" });
		const causeY = await f.tasks.create({ title: "new, unrelated regression" });

		const bus = new EventBus();
		const registry = new RunRegistry({
			handle: f.handle,
			bus,
			runsDir: join(f.root, "runs"),
		});
		const sessions = new SessionService({
			handle: f.handle,
			bus,
			log: silentLogger(),
			project: "demo",
			tasks: f.tasks,
			registry,
		});
		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
			selfRepairMainRed: () => false,
		});
		sessions.dismissInboxItem = (itemId) => inbox.dismiss(itemId);

		await f.setMainRed(causeX.id);
		const sessionX = await sessions.raise({
			source: "main_red",
			sourceKey: causeX.id,
			taskId: causeX.id,
			title: "main is red",
			summary: "broken by the old cause",
			whatWasTried: [],
			environment: "x",
		});

		// A different incident takes main red over; the first session is still open.
		await f.handle.db
			.insert(engineKv)
			.values({
				key: "main_red",
				value: { red: true, since: Date.now(), causeTaskId: causeY.id },
				updatedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: engineKv.key,
				set: {
					value: { red: true, since: Date.now(), causeTaskId: causeY.id },
					updatedAt: new Date(),
				},
			});
		const sessionY = await sessions.raise({
			source: "main_red",
			sourceKey: causeY.id,
			taskId: causeY.id,
			title: "main is red",
			summary: "broken by the new cause",
			whatWasTried: [],
			environment: "y",
		});
		expect(sessionY).not.toBeNull();

		// Dismiss the stale one.
		await sessions.resolve(
			sessionX?.id as string,
			"dismissed",
			"already fixed",
		);

		// The current main_red alert must survive.
		const item = (await inbox.list()).find((i) => i.kind === "main_red");
		expect(item).toBeDefined();
		expect(item?.taskId).toBe(causeY.id);
		await f.cleanup();
	});
});

describe("inbox: ownership conflicts", () => {
	test("two unordered tasks with overlapping owns produce one attention item per pair", async () => {
		const f = await fixture();
		const a = await f.tasks.create({ title: "a", owns: ["src/api"] });
		const b = await f.tasks.create({ title: "b", owns: ["src/api/**"] });
		await f.tasks.create({ title: "c", owns: ["docs"] });
		await f.tasks.create({ title: "d" });

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		const items = (await inbox.list()).filter(
			(i) => i.kind === "ownership_conflict",
		);
		expect(items).toHaveLength(1);
		expect(items[0]?.id).toBe(`ownership_conflict:${a.id}:${b.id}`);
		expect(items[0]?.severity).toBe("attention");
		expect(items[0]?.taskId).toBe(a.id);
		expect(items[0]?.title).toContain("two tasks claim the same files");
		expect(items[0]?.detail).toContain("src/api/**");
		expect(items[0]?.detail).toContain("one after the other");

		await inbox.dismiss(items[0]?.id as string);
		expect(
			(await inbox.list()).some((i) => i.kind === "ownership_conflict"),
		).toBe(false);
		await f.cleanup();
	});

	test("a dependency between the two orders them: no item", async () => {
		const f = await fixture();
		const a = await f.tasks.create({ title: "a", owns: ["src/api"] });
		await f.tasks.create({
			title: "b",
			owns: ["src/api"],
			dependsOn: [a.id],
		});

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		expect(
			(await inbox.list()).some((i) => i.kind === "ownership_conflict"),
		).toBe(false);
		await f.cleanup();
	});
});

describe("inbox: follow-ups to triage", () => {
	test("parked follow-ups group by the task that discovered them", async () => {
		const f = await fixture();
		const src = await f.tasks.create({ title: "source" });
		const other = await f.tasks.create({ title: "other source" });
		const followup = (title: string, from: string) =>
			f.tasks.create({
				title,
				status: "backlog",
				readyMode: "manual",
				source: "followup",
				discoveredFrom: from,
			});
		const one = await followup("one", src.id);
		const two = await followup("two", src.id);
		const three = await followup("three", other.id);
		const mineId = `followups:${src.id}:${[one.id, two.id].sort().join(",")}`;
		const theirsId = `followups:${other.id}:${three.id}`;
		// Promoted to automatic: someone triaged it, no longer listed.
		const triaged = await followup("four", src.id);
		await f.tasks.edit(triaged.id, { readyMode: "automatic" });

		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		const items = (await inbox.list()).filter((i) => i.kind === "followups");
		expect(items.map((i) => i.id).sort()).toEqual([mineId, theirsId].sort());
		const mine = items.find((i) => i.id === mineId);
		expect(mine?.severity).toBe("info");
		expect(mine?.taskId).toBe(src.id);
		expect(mine?.title).toBe(`2 follow-ups from ${src.id} to triage`);
		expect(mine?.detail).toContain("one");
		expect(mine?.detail).not.toContain("four");
		const theirs = items.find((i) => i.id === theirsId);
		expect(theirs?.title).toBe(`1 follow-up from ${other.id} to triage`);

		await inbox.dismiss(mineId);
		expect(
			(await inbox.list())
				.filter((i) => i.kind === "followups")
				.map((i) => i.id),
		).toEqual([theirsId]);

		// Renaming acknowledged discoveries keeps them dismissed; a new member
		// must surface even while the previous discoveries remain untriaged.
		await f.tasks.edit(one.id, { title: "clarified title" });
		expect((await inbox.list()).some((i) => i.id === mineId)).toBe(false);
		const later = await followup("new discovery", src.id);
		expect(await inbox.prune()).toBe(1);
		const refreshed = (await inbox.list()).find(
			(i) => i.kind === "followups" && i.taskId === src.id,
		);
		expect(refreshed?.id).not.toBe(mineId);
		expect(refreshed?.detail).toContain(`${later.id}: new discovery`);
		await f.cleanup();
	});

	test("a parked task not created as a follow-up is not listed", async () => {
		const f = await fixture();
		const src = await f.tasks.create({ title: "source" });
		await f.tasks.create({
			title: "manual",
			status: "backlog",
			readyMode: "manual",
		});
		// Lineage alone does not make it a follow-up: a human wrote this one.
		await f.tasks.create({
			title: "split by hand",
			status: "backlog",
			readyMode: "manual",
			discoveredFrom: src.id,
		});
		const inbox = new InboxService({
			handle: f.handle,
			project: "demo",
			tasks: f.tasks,
		});
		expect((await inbox.list()).some((i) => i.kind === "followups")).toBe(
			false,
		);
		await f.cleanup();
	});
});
