import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_TEMPLATES } from "@mfw/daemon/board-templates";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

const dirs: string[] = [];
afterAll(async () => {
	for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function caller() {
	const dir = await mkdtemp(join(tmpdir(), "mfw-board-config-"));
	dirs.push(dir);
	const planning = BOARD_TEMPLATES.find((t) => t.id === "planning");
	await writeFile(join(dir, "board.yaml"), planning?.yaml("PLAN") ?? "");
	const svc = {
		name: "demo",
		boardDir: dir,
		mfwDir: join(dir, ".mfw"),
		integrationBranch: "main",
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return { dir, api: createCaller({ orchestrator }).boardConfig };
}

describe("boardConfig", () => {
	test("get returns the yaml, roles and task types", async () => {
		const { api } = await caller();
		const view = await api.get({ project: "demo" });
		expect(view.yaml).toContain("statusMap");
		expect(view.statuses[0]).toMatchObject({ value: "planned", role: "ready" });
		expect(view.taskTypes).toContain("spike");
	});

	test("preview diffs without writing; apply writes and asks for a restart", async () => {
		const { api, dir } = await caller();
		const before = await readFile(join(dir, "board.yaml"), "utf8");
		const preview = await api.preview({ project: "demo", template: "kanban" });
		expect(preview.ok).toBe(true);
		if (!preview.ok) return;
		expect(preview.diff.length).toBeGreaterThan(0);
		expect(await readFile(join(dir, "board.yaml"), "utf8")).toBe(before);

		const applied = await api.save({ project: "demo", template: "kanban" });
		expect(applied.ok).toBe(true);
		expect(applied.needsRestart).toBe(true);
		const view = await api.get({ project: "demo" });
		expect(view.statuses.map((s) => s.value)).toEqual([
			"todo",
			"doing",
			"review",
			"done",
		]);
	});

	test("an invalid patch is a refusal, not a write", async () => {
		const { api, dir } = await caller();
		const before = await readFile(join(dir, "board.yaml"), "utf8");
		const result = await api.save({
			project: "demo",
			patch: { statuses: [{ value: "a b", role: "ready" }] },
		});
		expect(result.ok).toBe(false);
		expect(await readFile(join(dir, "board.yaml"), "utf8")).toBe(before);
		await expect(
			api.preview({ project: "demo", template: "nope" }),
		).rejects.toThrow(/no board template/);
	});
});
