import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { openProjectDb } from "@mfw/db/client";
import { runs } from "@mfw/db/schema";
import { createCaller } from "../src/root.ts";

const dirs: string[] = [];
afterAll(async () => {
	for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function caller() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-node-story-"));
	dirs.push(dir);
	const handle = await openProjectDb(dir);
	const runsDir = join(dir, "runs");
	await mkdir(join(runsDir, "R1"), { recursive: true });
	await writeFile(join(runsDir, "R1", "events.jsonl"), "");
	await handle.db.insert(runs).values({
		id: "R1",
		kind: "task",
		taskId: "MFW-1",
		label: "MFW-1",
		model: "sonnet",
		cwd: "/w",
		state: "completed",
		startedAt: new Date(1000),
	});
	const svc = {
		name: "demo",
		handle,
		registry: { runDir: (id: string) => join(runsDir, id) },
	} as unknown as ProjectServices;
	dirs.push(dir);
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return {
		api: createCaller({ orchestrator }),
		close: () => handle.close(),
	};
}

describe("node.story", () => {
	test("serves a task ref with transcript availability read from the run dir", async () => {
		const { api, close } = await caller();
		try {
			const page = await api.node.story({
				project: "demo",
				ref: "task:MFW-1",
			});
			expect(page.cursor).toBeNull();
			expect(page.entries).toMatchObject([
				{ kind: "run", ref: "run:R1", transcriptAvailable: true },
			]);
		} finally {
			close();
		}
	});

	test("refuses refs it cannot fold yet", async () => {
		const { api, close } = await caller();
		try {
			await expect(
				api.node.story({ project: "demo", ref: "run:R1" }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		} finally {
			close();
		}
	});
});
