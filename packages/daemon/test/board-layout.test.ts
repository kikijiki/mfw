import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
	buildBoardLayoutRecord,
	DEFAULT_PROTECTED_BOARD_PATHS,
	readBoardLayout,
	readProtectedBoardPaths,
	recordBoardLocation,
} from "../src/board-layout.ts";
import { relocateLegacyBoard } from "../src/board-relocate.ts";
import { boot } from "../src/boot.ts";
import { defaultBoardYaml } from "../src/default-board-config.ts";
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

function taskDoc(id: string, title: string): string {
	return `---\nmfw: 1\nid: ${id}\nrev: 1\ntitle: ${title}\ntype: implementation\nstatus: done\npriority: medium\n---\n`;
}

/** A board as the `.mfw/` era left it: board.yaml and tasks under `<folder>/.mfw`. */
async function legacyBoard(folder: string, n = 3): Promise<string[]> {
	const mfw = join(folder, ".mfw");
	await mkdir(join(mfw, "tasks"), { recursive: true });
	await writeFile(join(mfw, "board.yaml"), defaultBoardYaml("MFW"));
	const ids: string[] = [];
	for (let i = 1; i <= n; i++) {
		const id = `MFW-${i}`;
		ids.push(id);
		const dir = join(mfw, "tasks", `${id}-legacy-${i}`);
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "task.md"), taskDoc(id, `legacy ${i}`));
	}
	return ids;
}

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

describe("moving a legacy board out of .mfw", () => {
	test("attach moves it: same ids, one commit, and a second attach is a no-op", async () => {
		const root = await repo();
		const ids = await legacyBoard(root);
		await git(["add", "-f", "."], root);
		await git(["commit", "-q", "-m", "legacy board"], root);

		const first = await attach(root);
		let head: string;
		try {
			const svc = first.get("demo");
			expect((await svc.tasks.list()).map((t) => t.id).sort()).toEqual(ids);
			expect(existsSync(join(root, "board.yaml"))).toBe(true);
			expect(existsSync(join(root, "tasks", "MFW-1-legacy-1", "task.md"))).toBe(
				true,
			);
			expect(existsSync(join(root, ".mfw", "board.yaml"))).toBe(false);
			expect(existsSync(join(root, ".mfw", "tasks"))).toBe(false);
			// path-scoped commit, and nothing of the board is left tracked under .mfw
			const subjects = (await git(["log", "--format=%s"], root)).stdout;
			expect(subjects).toContain("mfw: move the board out of .mfw");
			expect((await git(["ls-files", "--", ".mfw"], root)).stdout).toBe("");
			expect((await git(["status", "--porcelain"], root)).stdout).toBe("");
			head = (await git(["rev-parse", "HEAD"], root)).stdout;
		} finally {
			await first.shutdown();
		}

		const second = await attach(root);
		try {
			const svc = second.get("demo");
			expect((await svc.tasks.list()).map((t) => t.id).sort()).toEqual(ids);
			expect((await git(["rev-parse", "HEAD"], root)).stdout).toBe(head);
		} finally {
			await second.shutdown();
		}
	});

	test("a collision is refused naming the path, and nothing is moved", async () => {
		const root = await repo();
		await legacyBoard(root, 2);
		// Somebody already has a `tasks` directory at the folder root.
		await mkdir(join(root, "tasks"), { recursive: true });
		await writeFile(join(root, "tasks", "notes.txt"), "mine\n");

		const lines: string[] = [];
		const orch = await boot({
			projects: [{ name: "demo", root, integrationBranch: "main" }],
			log: pino({ level: "error" }, { write: (s: string) => lines.push(s) }),
			autostart: false,
			mfwHome: await tmp("mfw-layout-home-"),
		});
		try {
			expect(() => orch.get("demo")).toThrow();
			expect(lines.join("\n")).toContain(join(root, "tasks"));
		} finally {
			await orch.shutdown();
		}
		expect(existsSync(join(root, ".mfw", "board.yaml"))).toBe(true);
		expect(
			existsSync(join(root, ".mfw", "tasks", "MFW-1-legacy-1", "task.md")),
		).toBe(true);
		expect(existsSync(join(root, "board.yaml"))).toBe(false);
		expect((await readdir(join(root, "tasks"))).sort()).toEqual(["notes.txt"]);
	});

	test("relocateLegacyBoard names the colliding path and changes nothing", async () => {
		const folder = await tmp("mfw-reloc-");
		await legacyBoard(folder, 1);
		await mkdir(join(folder, ".mfw", "adrs"), { recursive: true });
		await mkdir(join(folder, "adrs"), { recursive: true });
		const err = await relocateLegacyBoard({
			boardFolder: folder,
			daemonDir: join(folder, "daemon"),
			log: silentLogger(),
		}).catch((e: Error) => e);
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain(join(folder, "adrs"));
		expect(existsSync(join(folder, ".mfw", "board.yaml"))).toBe(true);
		expect(existsSync(join(folder, ".mfw", "tasks"))).toBe(true);
		expect(existsSync(join(folder, "board.yaml"))).toBe(false);
		expect(existsSync(join(folder, "tasks"))).toBe(false);
	});

	test("state moves to the daemon dir without overwriting, and an empty .mfw is removed", async () => {
		const folder = await tmp("mfw-reloc-board-");
		const daemon = await tmp("mfw-reloc-daemon-");
		await legacyBoard(folder, 1);
		await mkdir(join(folder, ".mfw", "state", "tasks"), { recursive: true });
		await writeFile(
			join(folder, ".mfw", "state", "tasks", "MFW-1.json"),
			"old\n",
		);
		await writeFile(
			join(folder, ".mfw", "state", "tasks", "MFW-2.json"),
			"two\n",
		);
		await mkdir(join(daemon, "state", "tasks"), { recursive: true });
		await writeFile(join(daemon, "state", "tasks", "MFW-1.json"), "kept\n");

		const result = await relocateLegacyBoard({
			boardFolder: folder,
			daemonDir: daemon,
			log: silentLogger(),
		});
		expect(result.moved.sort()).toEqual(["board.yaml", "tasks"]);
		expect(
			await Bun.file(join(daemon, "state", "tasks", "MFW-1.json")).text(),
		).toBe("kept\n");
		expect(
			await Bun.file(join(daemon, "state", "tasks", "MFW-2.json")).text(),
		).toBe("two\n");
		// MFW-1.json could not move (the destination won), so .mfw stays.
		expect(existsSync(join(folder, "board.yaml"))).toBe(true);

		// Idempotent: nothing further to do.
		const again = await relocateLegacyBoard({
			boardFolder: folder,
			daemonDir: daemon,
			log: silentLogger(),
		});
		expect(again.moved).toEqual([]);
	});

	test("an emptied .mfw is removed", async () => {
		const folder = await tmp("mfw-reloc-empty-");
		await legacyBoard(folder, 1);
		await relocateLegacyBoard({
			boardFolder: folder,
			daemonDir: join(await tmp("mfw-reloc-daemon-"), ".mfw"),
			log: silentLogger(),
		});
		expect(existsSync(join(folder, ".mfw"))).toBe(false);
		expect(existsSync(join(folder, "board.yaml"))).toBe(true);
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

	test("a pre-record file keeps protecting its paths", async () => {
		const root = await tmp("mfw-layout-old-");
		await mkdir(join(root, ".mfw", "state"), { recursive: true });
		await writeFile(
			join(root, ".mfw", "state", "board-location.json"),
			JSON.stringify({ paths: ["board.yaml", "notes"] }),
		);
		expect(await readBoardLayout(root)).toBeNull();
		expect(await readProtectedBoardPaths(root)).toEqual([
			"board.yaml",
			"notes",
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
