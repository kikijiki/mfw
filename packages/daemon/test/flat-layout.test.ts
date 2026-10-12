import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBoardConfig } from "@mfw/board-core";
import { defaultBoardYaml } from "../src/default-board-config.ts";
import { git } from "../src/git.ts";
import { silentLogger } from "../src/log.ts";
import {
	listAttachments,
	putAttachment,
	readSpec,
	writeSpec,
} from "../src/tasks/extras.ts";
import { TaskIndex } from "../src/tasks/index.ts";

/**
 * A board that is not the daemon's own: `layout: flat` tasks (one file each,
 * `tasks/POOT-1.md`, no directory) and its own status vocabulary, translated
 * through the `x-mfw-daemon.statusMap` in its own board.yaml. Everything the
 * index hands the rest of the daemon is canonical; everything it writes back
 * is this board's wording.
 */

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

const STATUS_MAP = `x-mfw-daemon:
  statusMap:
    ready: [planned]
    in_progress: [doing]
    done: [done]
    blocked: [deferred]
    backlog: [planned]
`;

/** The default board.yaml, made flat and made to speak this board's language. */
function flatBoardYaml(withStatusMap: boolean): string {
	const yaml = defaultBoardYaml("POOT")
		.replace("    layout: directory\n", "    layout: flat\n")
		.replace("    primary: task.md\n", "")
		.replace("    siblings: [spec.md, files/]\n", "")
		.replace("    slugFrom: title\n", "")
		.replace(
			"        values: [draft, backlog, ready, in_progress, blocked, review, done, archived]\n        default: backlog\n",
			"        values: [planned, doing, done, deferred]\n        default: planned\n",
		);
	expect(yaml).not.toContain("layout: directory");
	expect(yaml).toContain("values: [planned, doing, done, deferred]");
	return withStatusMap ? `${yaml}${STATUS_MAP}` : yaml;
}

function writeTaskFile(
	tasksDir: string,
	id: string,
	title: string,
	status: string,
): Promise<void> {
	return writeFile(
		join(tasksDir, `${id}.md`),
		`---\nmfw: 1\nid: ${id}\nrev: 1\ntitle: ${title}\nstatus: ${status}\n---\n\nBody.\n`,
	);
}

interface FlatBoard {
	root: string;
	mfwDir: string;
	tasksDir: string;
}

async function flatBoard(withStatusMap = true): Promise<FlatBoard> {
	const root = await mkdtemp(join(tmpdir(), "mfw-flat-"));
	roots.push(root);
	await git(["init", "-q", "-b", "main", "."], root);
	await git(["config", "user.email", "t@t"], root);
	await git(["config", "user.name", "t"], root);
	const mfwDir = join(root, ".mfw");
	const tasksDir = join(mfwDir, "tasks");
	await mkdir(tasksDir, { recursive: true });
	await writeFile(join(mfwDir, "board.yaml"), flatBoardYaml(withStatusMap));
	await writeTaskFile(tasksDir, "POOT-1", "Plan the migration", "planned");
	await writeTaskFile(tasksDir, "POOT-2", "Do the migration", "doing");
	await writeTaskFile(tasksDir, "POOT-3", "Waiting on reviews", "deferred");
	await git(["add", "-A"], root);
	await git(["commit", "-qm", "board"], root);
	return { root, mfwDir, tasksDir };
}

/** What attaching does: read the config, then build the task index over it. */
async function attach(board: FlatBoard): Promise<TaskIndex> {
	const config = await loadBoardConfig(join(board.mfwDir, "board.yaml"));
	return new TaskIndex({
		boardDir: board.mfwDir,
		stateDir: board.mfwDir,
		config,
		taskKey: "POOT",
		log: silentLogger(),
	});
}

interface FlatEnv extends FlatBoard {
	index: TaskIndex;
}

async function flatEnv(): Promise<FlatEnv> {
	const board = await flatBoard();
	return { ...board, index: await attach(board) };
}

const rawTask = (env: FlatEnv, id: string) =>
	readFile(join(env.tasksDir, `${id}.md`), "utf8");

describe("a board whose status map has no backlog or draft", () => {
	test("a new task starts in the nearest role the map declares", async () => {
		const board = await flatBoard(false);
		const noBacklog = STATUS_MAP.replace("    backlog: [planned]\n", "");
		const yaml = await readFile(join(board.mfwDir, "board.yaml"), "utf8");
		await writeFile(join(board.mfwDir, "board.yaml"), `${yaml}${noBacklog}`);
		const index = await attach(board);
		await index.load();

		const created = await index.create({ title: "Fresh card" });

		expect(created.status).toBe("ready");
		expect(await readFile(created.path, "utf8")).toContain("title: Fresh card");
	});
});

describe("a flat board with its own statuses", () => {
	test("every task loads with the canonical status its board value reads as", async () => {
		const env = await flatEnv();

		const report = await env.index.load();

		expect(report.loaded).toBe(3);
		expect(report.quarantined).toEqual([]);
		expect(env.index.list().map((t) => [t.id, t.status, t.path])).toEqual([
			["POOT-1", "ready", join(env.tasksDir, "POOT-1.md")],
			["POOT-2", "in_progress", join(env.tasksDir, "POOT-2.md")],
			["POOT-3", "blocked", join(env.tasksDir, "POOT-3.md")],
		]);
	});

	test("a status change writes this board's own value into the file", async () => {
		const env = await flatEnv();
		await env.index.load();

		await env.index.update("POOT-1", () => [], { status: "in_progress" });

		expect(await rawTask(env, "POOT-1")).toContain("status: doing");
		expect(env.index.get("POOT-1")?.status).toBe("in_progress");
	});

	test("a field edit keeps the board's own status wording", async () => {
		const env = await flatEnv();
		await env.index.load();

		const { fields } = await env.index.update("POOT-2", (draft) => {
			draft.frontmatter.title = "Renamed";
			return ["title"];
		});

		expect(fields).toEqual(["title"]);
		const raw = await rawTask(env, "POOT-2");
		expect(raw).toContain("title: Renamed");
		expect(raw).toContain("status: doing");
		expect(env.index.get("POOT-2")?.status).toBe("in_progress");
	});

	test("a new task is written as tasks/POOT-<n>.md, in this board's status", async () => {
		const env = await flatEnv();
		await env.index.load();

		const created = await env.index.create({ title: "Add the report" });

		expect(created.id).toBe("POOT-4");
		expect(existsSync(join(env.tasksDir, "POOT-4.md"))).toBe(true);
		// `backlog` translates to `planned`, which is this board's own default,
		// so the renderer keeps quiet about it — and `planned` reads back as
		// `ready` (`ready` lists it first), the status a scheduler dispatches.
		expect(created.status).toBe("ready");
		expect(env.index.get("POOT-4")?.status).toBe("ready");

		// A role whose board value is not the default: the daemon says
		// `blocked`, the file says `deferred`.
		const blocked = await env.index.create({
			title: "Blocked one",
			status: "blocked",
		});
		expect(blocked.id).toBe("POOT-5");
		expect(await rawTask(env, "POOT-5")).toContain("status: deferred");
		expect(blocked.status).toBe("blocked");
	});

	test("claiming and releasing speak the board's own status words", async () => {
		const env = await flatEnv();
		await env.index.load();

		const claimed = await env.index.claim("POOT-1", "run-1", 60_000);

		expect(claimed?.status).toBe("in_progress");
		expect(await rawTask(env, "POOT-1")).toContain("status: doing");

		const released = await env.index.releaseClaim(
			"POOT-1",
			"run-1",
			"done",
			null,
		);

		expect(released?.record.status).toBe("done");
		expect(await rawTask(env, "POOT-1")).toContain("status: done");
	});

	test("the board refuses to attach without a status map, naming the map to add", async () => {
		const board = await flatBoard(false);

		await expect(attach(board)).rejects.toThrow(/'planned'/);
		await expect(attach(board)).rejects.toThrow(/'doing'/);
		await expect(attach(board)).rejects.toThrow(/'deferred'/);
		await expect(attach(board)).rejects.toThrow(/x-mfw-daemon/);
		await expect(attach(board)).rejects.toThrow(/statusMap:/);
	});
});

describe("spec and attachments on a flat board", () => {
	test("they read as empty, even where leftovers sit in the shared directory", async () => {
		const env = await flatEnv();
		// Leftovers of a board that used to be directory-layout: they are not
		// this task's spec or attachments, and must not be read as such.
		await writeFile(join(env.tasksDir, "spec.md"), "not a task's spec\n");
		await mkdir(join(env.tasksDir, "files"), { recursive: true });
		await writeFile(join(env.tasksDir, "files", "a.png"), "x");

		expect(await readSpec(env.tasksDir)).toEqual({
			body: "",
			hash: "",
			exists: false,
		});
		expect(await listAttachments(env.tasksDir)).toEqual([]);
	});

	test("writing them is refused, with the flat-board error", async () => {
		const env = await flatEnv();
		await expect(writeSpec(env.tasksDir, "notes", undefined)).rejects.toThrow(
			/not supported by a flat board/,
		);
		await expect(
			putAttachment(env.tasksDir, "a.png", new Uint8Array([1])),
		).rejects.toThrow(/not supported by a flat board/);
		expect(existsSync(join(env.tasksDir, "spec.md"))).toBe(false);
		expect(existsSync(join(env.tasksDir, "files"))).toBe(false);
	});

	test("the index never hands out the shared tasks directory as a task directory", async () => {
		const env = await flatEnv();
		await env.index.load();

		await expect(
			env.index.withTaskDir("POOT-1", async (dir) => dir),
		).rejects.toThrow(/not supported by a flat board/);
	});
});
