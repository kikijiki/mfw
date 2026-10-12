import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MfwEvent } from "@mfw/core/events";
import { openProjectDb, type ProjectDbHandle } from "../src/client.ts";
import { appendEvent, listEvents, type StoredEvent } from "../src/eventlog.ts";
import { events, runs } from "../src/schema.ts";

interface Env {
	dir: string;
	handle: ProjectDbHandle;
	emit: (event: MfwEvent) => Promise<number>;
}

const envs: Env[] = [];

const runIdOf = (e: StoredEvent | undefined) =>
	e && "runId" in e ? e.runId : undefined;

async function freshEnv(): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-events-run-"));
	const handle = await openProjectDb(dir);
	const env: Env = {
		dir,
		handle,
		emit: async (event) =>
			(await handle.withTx((tx) => appendEvent(tx, event))).seq,
	};
	envs.push(env);
	return env;
}

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.handle.close();
		await rm(env.dir, { recursive: true, force: true });
	}
});

describe("run-indexed events", () => {
	test("runId filter returns only that run's events, and ix_events_run exists", async () => {
		const env = await freshEnv();
		for (const runId of ["R1", "R2", "R1"]) {
			await env.emit({
				type: "run.state_changed",
				runId,
				payload: { from: "starting", to: "running" },
			});
		}
		const page = await listEvents(env.handle.db, { runId: "R1" });
		expect(page.events.map(runIdOf)).toEqual(["R1", "R1"]);
		const idx = await env.handle.client.execute(
			"SELECT name FROM sqlite_master WHERE type='index' AND name='ix_events_run'",
		);
		expect(idx.rows).toHaveLength(1);
	});

	test("taskId filter finds run transitions of that task's runs", async () => {
		const env = await freshEnv();
		await env.emit({
			type: "run.started",
			runId: "R1",
			taskId: "MFW-1",
			payload: { kind: "task", model: "m", taskId: "MFW-1" },
		});
		await env.emit({
			type: "run.state_changed",
			runId: "R1",
			taskId: "MFW-1",
			payload: { from: "starting", to: "running" },
		});
		await env.emit({
			type: "run.finalize_step",
			runId: "R1",
			taskId: "MFW-1",
			payload: { step: "verify", ok: true },
		});
		const page = await listEvents(env.handle.db, { taskId: "MFW-1" });
		expect(page.events.map((e) => e.type)).toEqual([
			"run.finalize_step",
			"run.state_changed",
			"run.started",
		]);
	});

	test("the migration's task_id backfill fills old run events from their run", async () => {
		const env = await freshEnv();
		await env.handle.db.insert(runs).values({
			id: "R9",
			kind: "task",
			taskId: "MFW-9",
			label: "MFW-9",
			model: "m",
			cwd: "/tmp",
			startedAt: new Date(),
		});
		await env.handle.db.insert(events).values({
			ts: new Date(),
			type: "run.state_changed",
			runId: "R9",
			payload: { from: "starting", to: "running" },
		});
		const before = await listEvents(env.handle.db, { taskId: "MFW-9" });
		expect(before.events).toHaveLength(0);
		const sqlText = await readFile(
			join(import.meta.dir, "../migrations/0013_events_run_index.sql"),
			"utf8",
		);
		const update = sqlText
			.split("--> statement-breakpoint")
			.map((s) => s.trim())
			.find((s) => s.startsWith("UPDATE"));
		expect(update).toBeTruthy();
		await env.handle.client.execute(update as string);
		const after = await listEvents(env.handle.db, { taskId: "MFW-9" });
		expect(after.events).toHaveLength(1);
	});
});
