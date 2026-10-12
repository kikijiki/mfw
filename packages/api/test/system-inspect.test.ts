import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectBoardFolder } from "@mfw/daemon/board-inspect";
import type { Orchestrator } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

const scratch: string[] = [];

afterEach(async () => {
	for (const path of scratch.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
});

const BOARD_YAML = `mfw: 1

types:
  task:
    layout: flat
    dir: tasks
    id: { strategy: own-sequence, key: POOT }
    slugFrom: title
    fields:
      title: {}
      status:
        values: [planned, doing, done]
        default: planned
`;

const TASK = `---
mfw: 1
id: POOT-1
rev: 1
title: One
status: planned
---
body of POOT-1
`;

function caller() {
	const orchestrator = {
		list: () => [],
	} as unknown as Orchestrator;
	return createCaller({ orchestrator });
}

describe("system.inspectBoardFolder", () => {
	test("reports a board in a temp folder in exactly the inspector's shape", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-inspect-api-"));
		scratch.push(dir);
		await writeFile(join(dir, "board.yaml"), BOARD_YAML);
		await mkdir(join(dir, "tasks"));
		await writeFile(join(dir, "tasks", "POOT-1.md"), TASK);
		const real = await realpath(dir);

		const viaApi = await caller().system.inspectBoardFolder({ path: dir });

		expect(viaApi).toEqual(await inspectBoardFolder(real));
		expect(viaApi.path).toBe(real);
		expect(viaApi).toMatchObject({
			exists: true,
			isGitRepo: false,
			location: "root",
			boardYaml: join(real, "board.yaml"),
			valid: true,
			error: null,
			key: "POOT",
		});
		expect(viaApi.types).toEqual([
			{
				name: "task",
				dir: "tasks",
				layout: "flat",
				documents: 1,
				statusField: "status",
				statuses: ["planned", "doing", "done"],
				statusCounts: { planned: 1, doing: 0, done: 0 },
			},
		]);
	});

	test("refuses paths projectDirectory refuses", async () => {
		const dir = await mkdtemp(join(tmpdir(), "mfw-inspect-api-"));
		scratch.push(dir);
		const file = join(dir, "board.yaml");
		await writeFile(file, BOARD_YAML);

		await expect(
			caller().system.inspectBoardFolder({ path: file }),
		).rejects.toThrow();
		await expect(
			caller().system.inspectBoardFolder({ path: join(dir, "missing") }),
		).rejects.toThrow();
	});
});
