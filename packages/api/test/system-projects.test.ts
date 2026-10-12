import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

const scratch: string[] = [];

afterEach(async () => {
	for (const path of scratch.splice(0)) {
		await rm(path, { recursive: true, force: true });
	}
});

function caller(
	projects: Array<Pick<ProjectServices, "name" | "root">> = [],
	attach?: Orchestrator["attach"],
	detach?: Orchestrator["detach"],
) {
	const orchestrator = {
		list: () => projects,
		attach,
		detach,
	} as unknown as Orchestrator;
	return createCaller({ orchestrator });
}

describe("the project repository picker", () => {
	test("lists folders, identifies Git roots, and marks attached repositories", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-picker-"));
		scratch.push(root);
		const repo = join(root, "alpha");
		await mkdir(join(repo, ".git"), { recursive: true });
		await mkdir(join(root, "zeta"));
		await writeFile(join(root, "not-a-folder"), "ignored");

		const result = await caller([
			{ name: "alpha", root: repo },
		]).system.projectDirectory({
			path: root,
		});

		expect(result.path).toBe(root);
		expect(result.parent).toBeTruthy();
		expect(result.directories.map((entry) => entry.name)).toEqual([
			"alpha",
			"zeta",
		]);
		expect(result.directories[0]).toMatchObject({
			path: repo,
			isRepository: true,
			attached: true,
		});
		expect(result.directories[1]).toMatchObject({
			isRepository: false,
			attached: false,
		});
	});

	test("derives a unique project name from the selected repository", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-project-"));
		scratch.push(root);
		const selected = join(root, "demo");
		await mkdir(selected);
		let attachedName = "";

		const api = caller(
			[{ name: "demo", root: join(root, "elsewhere") }],
			async (config) => {
				attachedName = config.name;
				return {
					name: config.name,
					root: config.root,
					integrationBranch: "main",
				} as ProjectServices;
			},
		);

		const result = await api.system.addProject({ root: selected });

		expect(attachedName).toBe("demo-2");
		expect(result.name).toBe("demo-2");
	});

	test("passes the board template and board folder to attach, and can create the folder", async () => {
		const root = await mkdtemp(join(tmpdir(), "mfw-project-"));
		scratch.push(root);
		const repo = join(root, "demo");
		await mkdir(repo);
		const boards = join(root, "boards");
		await mkdir(boards);
		const boardRoot = join(boards, "demo-board");
		let seen: Record<string, unknown> = {};
		const api = caller([], async (config) => {
			seen = { ...config };
			return {
				name: config.name,
				root: config.root,
				integrationBranch: "main",
			} as ProjectServices;
		});

		await api.system.addProject({
			root: repo,
			boardRoot,
			template: "kanban",
			createBoardFolder: true,
		});

		expect(seen.template).toBe("kanban");
		expect(seen.boardRoot).toBe(boardRoot);
		expect(seen).not.toHaveProperty("createBoardFolder");
		expect((await stat(boardRoot)).isDirectory()).toBe(true);

		await expect(
			api.system.addProject({
				root: repo,
				boardRoot: join(root, "no-parent", "board"),
				createBoardFolder: true,
			}),
		).rejects.toThrow("cannot create");
	});

	test("removes an attachment without exposing a data-deletion option", async () => {
		let detached = "";
		const api = caller([], undefined, async (name) => {
			detached = name;
			return { name, root: "/repo/demo", configRemoved: true };
		});

		const result = await api.system.removeProject({ name: "demo" });

		expect(detached).toBe("demo");
		expect(result).toEqual({
			name: "demo",
			root: "/repo/demo",
			configRemoved: true,
		});
		const staleClientResult = await api.system.removeProject({
			name: "demo",
			deleteMfwData: true,
		} as { name: string });
		expect(staleClientResult.configRemoved).toBe(true);
		expect(detached).toBe("demo");
	});
});
