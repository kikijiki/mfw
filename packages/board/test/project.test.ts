import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findMfwRoot, openMfwProject } from "../src/project.ts";

const dirs: string[] = [];
async function freshRepo(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "board-project-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

describe("findMfwRoot", () => {
	test("finds .mfw/board.yaml by walking up from a nested cwd", async () => {
		const repo = await freshRepo();
		await mkdir(join(repo, ".mfw"), { recursive: true });
		await writeFile(join(repo, ".mfw", "board.yaml"), "mfw: 1\ntypes: {}\n");
		const nested = join(repo, "a", "b", "c");
		await mkdir(nested, { recursive: true });
		expect(findMfwRoot(nested)).toBe(join(repo, ".mfw"));
	});

	test("returns null when no .mfw/board.yaml exists anywhere above", async () => {
		const repo = await freshRepo();
		expect(findMfwRoot(repo)).toBeNull();
	});
});

describe("openMfwProject", () => {
	test("opens a store against the discovered config", async () => {
		const repo = await freshRepo();
		await mkdir(join(repo, ".mfw"), { recursive: true });
		await writeFile(
			join(repo, ".mfw", "board.yaml"),
			[
				"mfw: 1",
				"types:",
				"  task:",
				"    layout: flat",
				"    dir: tasks",
				"    id: { strategy: own-sequence, key: MFW }",
				"    fields:",
				"      title: {}",
			].join("\n"),
		);
		const project = await openMfwProject(repo);
		const doc = await project.store.createDocument("task", {
			fields: { title: "hello" },
		});
		expect(doc.id).toBe("MFW-1");
	});
});
