import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "@mfw/daemon/log";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { decisions } from "@mfw/db/schema";
import { eq } from "drizzle-orm";
import { makeTasks } from "../../daemon/test/fixtures/board.ts";
import { createCaller } from "../src/root.ts";

/**
 * U4-03: every human mutation through the API leaves one `role: human`
 * decision, so the audit trail covers the person as it covers the brain.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0)) await c();
});

async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-test-human-actions-"));
	const mfwDir = join(dir, ".mfw");
	const handle = await openProjectDb(mfwDir);
	const bus = new EventBus();
	const tasks = await makeTasks(handle, bus, mfwDir);
	cleanups.push(async () => {
		handle.close();
		await rm(dir, { recursive: true, force: true });
	});
	const engineCalls: string[] = [];
	const svc = {
		name: "demo",
		handle,
		bus,
		log: silentLogger(),
		tasks,
		registry: {
			get: async (id: string) =>
				id === "RUN1" ? { id, taskId: "MFW-1", kind: "task" } : null,
		},
		engine: {
			stop: async (id: string) => void engineCalls.push(`stop:${id}`),
			steer: async (id: string, m: string) =>
				void engineCalls.push(`steer:${id}:${m}`),
			startTask: async () => ({ runId: "RUN2" }),
			startPlan: async () => ({ runId: "RUN3" }),
		},
		supervisor: { wake() {} },
		clarify: { answer: async () => ({ ok: true }) },
	} as unknown as ProjectServices;
	const caller = createCaller({
		orchestrator: {
			list: () => [svc],
			get: () => svc,
		} as unknown as Orchestrator,
	});
	const rows = async () =>
		handle.db.select().from(decisions).where(eq(decisions.role, "human"));
	return { caller, rows, tasks, engineCalls };
}

describe("human actions are decisions", () => {
	test("tasks.create, update, move and remove each write one human row", async () => {
		const { caller, rows } = await fixture();
		const created = await caller.tasks.create({
			project: "demo",
			title: "Wire the thing",
		});
		await caller.tasks.update({
			project: "demo",
			id: created.id,
			baseRev: created.contentRev,
			patch: { title: "Wire the other thing" },
		});
		await caller.tasks.move({
			project: "demo",
			id: created.id,
			to: "ready",
			reason: "go",
		});
		await caller.tasks.remove({ project: "demo", id: created.id });

		const got = await rows();
		expect(got.map((r) => r.action)).toEqual([
			"tasks.create",
			"tasks.update",
			"tasks.move",
			"tasks.remove",
		]);
		for (const r of got) {
			expect(r.taskId).toBe(created.id);
			expect(r.model).toBe("human");
			expect(r.status).toBe("ok");
		}
		expect(got[1]?.input).toMatchObject({ fields: ["title"] });
		expect(got[2]?.reason).toBe("go");
		expect(got[2]?.input).toMatchObject({ to: "ready" });
	});

	test("runs start, stop and steer, and a clarify answer, write human rows", async () => {
		const { caller, rows, engineCalls } = await fixture();
		await caller.runs.startTask({ project: "demo", taskId: "MFW-1" });
		await caller.runs.stop({ project: "demo", runId: "RUN1" });
		await caller.runs.steer({
			project: "demo",
			runId: "RUN1",
			message: "narrow it",
		});
		await caller.clarify.answer({
			project: "demo",
			runId: "RUN1",
			answers: [{ index: 0, answer: "yes" }],
		});
		expect(engineCalls).toEqual(["stop:RUN1", "steer:RUN1:narrow it"]);
		const got = await rows();
		expect(got.map((r) => r.action)).toEqual([
			"runs.start",
			"runs.stop",
			"runs.steer",
			"runs.answer",
		]);
		expect(got[0]?.subjectRunId).toBe("RUN2");
		expect(got[1]).toMatchObject({ subjectRunId: "RUN1", taskId: "MFW-1" });
		expect(got[2]?.reason).toBe("narrow it");
	});

	test("a refused mutation leaves no row", async () => {
		const { caller, rows } = await fixture();
		await expect(
			caller.tasks.update({
				project: "demo",
				id: "MFW-404",
				patch: { title: "nope" },
			}),
		).rejects.toBeDefined();
		expect(await rows()).toHaveLength(0);
	});
});
