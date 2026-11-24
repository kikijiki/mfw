import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildBoardLayoutRecord,
	DEFAULT_PROTECTED_BOARD_PATHS,
	readBoardLayout,
	readProtectedBoardPaths,
	recordBoardLocation,
} from "../src/board-layout.ts";
import { boot } from "../src/boot.ts";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";

/**
 * Where the board lives: at the root of its board folder (the repository root
 * unless `boardRoot` is set), with `.mfw/` under the repository holding daemon
 * state only.
 */

const dirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(prefix = "mfw-layout-"): Promise<string> {
	const root = await tmp(prefix);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	await writeFile(join(root, "README.md"), "# layout\n");
	await git(["add", "-A"], root);
	await git(["commit", "-q", "-m", "init"], root);
	return root;
}

async function attach(root: string, boardRoot?: string) {
	const home = await tmp("mfw-layout-home-");
	return boot({
		projects: [
			{
				name: "demo",
				root,
				integrationBranch: "main",
				...(boardRoot ? { boardRoot } : {}),
			},
		],
		log: silentLogger(),
		autostart: false,
		mfwHome: home,
	});
}

/** A board as the `.mfw/` era left it: board.yaml and tasks under `<folder>/.mfw`. */
describe("board layout: the board sits at the root of its folder", () => {
	test("a fresh repository attaches with board.yaml and tasks/ at its root", async () => {
		const root = await repo();
		const orch = await attach(root);
		try {
			expect(existsSync(join(root, "board.yaml"))).toBe(true);
			expect(existsSync(join(root, "tasks"))).toBe(true);
			expect(existsSync(join(root, ".mfw", "mfw.db"))).toBe(true);
			expect(existsSync(join(root, ".mfw", "board.yaml"))).toBe(false);
			expect(existsSync(join(root, ".mfw", "tasks"))).toBe(false);
			// Nothing but board files in the board folder besides the repo's own.
			for (const stray of ["state", "locks", ".board"]) {
				expect(existsSync(join(root, stray))).toBe(false);
			}
		} finally {
			await orch.shutdown();
		}
	});

	test("the git exclude no longer re-admits board paths under .mfw", async () => {
		const root = await repo();
		const orch = await attach(root);
		try {
			const exclude = await Bun.file(
				join(root, ".git", "info", "exclude"),
			).text();
			expect(exclude).toContain("/.mfw/*");
			expect(exclude).toContain("!/.mfw/triggers/");
			for (const gone of ["tasks", "adrs", "board.yaml", "templates"]) {
				expect(exclude).not.toContain(`!/.mfw/${gone}`);
			}
		} finally {
			await orch.shutdown();
		}
	});

	test("a task is created at <board folder>/tasks and its sidecar goes under <repo>/.mfw/state", async () => {
		const root = await repo();
		const orch = await attach(root);
		try {
			const svc = orch.get("demo");
			const t = await svc.tasks.create({ title: "where do I live" });
			expect(
				existsSync(join(root, "tasks", `${t.id}-where-do-i-live`, "task.md")),
			).toBe(true);
			expect(
				existsSync(join(root, ".mfw", "state", "tasks", `${t.id}.json`)),
			).toBe(true);
			expect(existsSync(join(root, "state"))).toBe(false);
		} finally {
			await orch.shutdown();
		}
	});

	test("a separate board folder holds the board; the repo keeps every sidecar", async () => {
		const root = await repo("mfw-layout-code-");
		const board = await repo("mfw-layout-board-");
		const orch = await attach(root, board);
		try {
			expect(existsSync(join(board, "board.yaml"))).toBe(true);
			expect(existsSync(join(board, ".mfw"))).toBe(false);
			expect(existsSync(join(root, ".mfw", "mfw.db"))).toBe(true);
			expect(existsSync(join(root, "board.yaml"))).toBe(false);

			const svc = orch.get("demo");
			const t = await svc.tasks.create({ title: "elsewhere" });
			expect(
				existsSync(join(board, "tasks", `${t.id}-elsewhere`, "task.md")),
			).toBe(true);
			expect(
				existsSync(join(root, ".mfw", "state", "tasks", `${t.id}.json`)),
			).toBe(true);
			// The board folder holds board files only: no state, locks, counters or .mfw.
			expect((await readdir(board)).sort()).toEqual(
				[".git", "README.md", "adrs", "board.yaml", "tasks"].sort(),
			);
			// ...and a board repository is never told about `.mfw`.
			const exclude = await Bun.file(join(board, ".git", "info", "exclude"))
				.text()
				.catch(() => "");
			expect(exclude).not.toContain(".mfw");
		} finally {
			await orch.shutdown();
		}
	});
});

describe("a directory that is not a board", () => {
	test("a tasks directory with no board.yaml refuses the attach, creating nothing", async () => {
		const root = await repo();
		await mkdir(join(root, "tasks"), { recursive: true });
		await writeFile(join(root, "tasks", "todo.txt"), "buy milk\n");

		const orch = await attach(root);
		try {
			expect(() => orch.get("demo")).toThrow();
		} finally {
			await orch.shutdown();
		}
		expect(existsSync(join(root, "board.yaml"))).toBe(false);
		expect((await readdir(join(root, "tasks"))).sort()).toEqual(["todo.txt"]);
	});
});

describe("the board layout record", () => {
	const types = { task: { dir: "tasks" }, adr: { dir: "adrs" } } as never;

	test("a board at the repository root is layout (a), committed with the code", () => {
		const r = buildBoardLayoutRecord({
			repoRoot: "/r",
			boardFolder: "/r",
			config: { types },
		});
		expect(r).toEqual({
			version: 1,
			layout: "in-repo",
			root: "/r",
			commitRepo: "/r",
			push: "with-code",
			protectedPaths: ["board.yaml", "tasks", "adrs"],
		});
	});

	test("a nested board folder is still layout (a), with prefixed paths", () => {
		const r = buildBoardLayoutRecord({
			repoRoot: "/r",
			boardFolder: "/r/docs/board",
			config: { types },
		});
		expect(r.layout).toBe("in-repo");
		expect(r.protectedPaths).toContain("docs/board/tasks");
	});

	test("a board outside the repository is layout (c) and commits to its own repo", () => {
		const r = buildBoardLayoutRecord({
			repoRoot: "/r",
			boardFolder: "/b",
			config: { types },
		});
		expect(r.layout).toBe("separate-repo");
		expect(r.commitRepo).toBe("/b");
		expect(r.push).toBe("board-repo");
		expect(r.protectedPaths).toEqual([]);
	});

	test("the push policy can be overridden", () => {
		const r = buildBoardLayoutRecord({
			repoRoot: "/r",
			boardFolder: "/r",
			config: { types },
			push: "untracked",
		});
		expect(r.push).toBe("untracked");
	});

	test("a record round-trips, and both readers agree", async () => {
		const root = await tmp("mfw-layout-rec-");
		const rec = buildBoardLayoutRecord({
			repoRoot: root,
			boardFolder: root,
			config: { types },
		});
		await recordBoardLocation(root, rec);
		expect(await readBoardLayout(root)).toEqual(rec);
		expect(await readProtectedBoardPaths(root)).toEqual(rec.protectedPaths);
	});

	test("nothing recorded fails closed to the default paths", async () => {
		const root = await tmp("mfw-layout-none-");
		expect(await readBoardLayout(root)).toBeNull();
		expect(await readProtectedBoardPaths(root)).toEqual([
			...DEFAULT_PROTECTED_BOARD_PATHS,
		]);
	});

	test("an invalid record is ignored rather than trusted", async () => {
		const root = await tmp("mfw-layout-bad-");
		await mkdir(join(root, ".mfw", "state"), { recursive: true });
		await writeFile(
			join(root, ".mfw", "state", "board-location.json"),
			JSON.stringify({
				version: 1,
				layout: "branch",
				root: "/x",
				commitRepo: "/x",
				push: "with-code",
				protectedPaths: [],
			}),
		);
		expect(await readBoardLayout(root)).toBeNull();
		expect(await readProtectedBoardPaths(root)).toEqual([
			...DEFAULT_PROTECTED_BOARD_PATHS,
		]);
	});

	test("attach records layout (a), and layout (c) for a separate board folder", async () => {
		const root = await repo();
		const a = await attach(root);
		await a.shutdown();
		const rec = await readBoardLayout(root);
		expect(rec?.layout).toBe("in-repo");
		expect(rec?.protectedPaths).toContain("tasks");

		const code = await repo("mfw-layout-code-");
		const boardDir = await repo("mfw-layout-sep-");
		const c = await attach(code, boardDir);
		await c.shutdown();
		const rec2 = await readBoardLayout(code);
		expect(rec2?.layout).toBe("separate-repo");
		expect(rec2?.commitRepo).toBe(boardDir);
	});
});
