import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectBoardFolder } from "../src/board-inspect.ts";
import {
	type BoardTemplate,
	getBoardTemplate,
} from "../src/board-templates.ts";

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await rm(dir, { recursive: true, force: true });
	}
});

async function freshDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-inspect-"));
	dirs.push(dir);
	return dir;
}

const ROOT_BOARD_YAML = `mfw: 1

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
  note:
    layout: flat
    dir: notes
    id: { strategy: inherit, from: task }
    fields:
      title: {}
`;

const LEGACY_BOARD_YAML = `mfw: 1

types:
  task:
    layout: directory
    dir: tasks
    primary: task.md
    id: { strategy: own-sequence, key: TSK }
    slugFrom: title
    fields:
      title: {}
      status:
        values: [open, closed]
        default: open
`;

async function writeDoc(
	path: string,
	id: string,
	fields: Record<string, string>,
): Promise<void> {
	const raw = [
		"---",
		"mfw: 1",
		`id: ${id}`,
		"rev: 1",
		...Object.entries(fields).map(([name, value]) => `${name}: ${value}`),
		"---",
		`body of ${id}`,
	].join("\n");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${raw}\n`);
}

/** A root-layout board with four tasks (planned, doing, doing, done) and one note. */
async function writeRootBoard(dir: string): Promise<void> {
	await writeFile(join(dir, "board.yaml"), ROOT_BOARD_YAML);
	for (const [id, status] of [
		["POOT-1", "planned"],
		["POOT-2", "doing"],
		["POOT-3", "doing"],
		["POOT-4", "done"],
	] as const) {
		await writeDoc(join(dir, "tasks", `${id}.md`), id, {
			title: id,
			status,
		});
	}
	await writeDoc(join(dir, "notes", "POOT-9.md"), "POOT-9", {
		title: "a note",
	});
}

/** Every entry under `dir`, with its mtime: an unchanged tree reads back equal. */
async function snapshot(dir: string): Promise<string[]> {
	const rows: string[] = [`${dir} ${(await stat(dir)).mtimeMs}`];
	const walk = async (current: string) => {
		const entries = (await readdir(current, { withFileTypes: true })).sort(
			(a, b) => a.name.localeCompare(b.name),
		);
		for (const entry of entries) {
			const path = join(current, entry.name);
			rows.push(`${path} ${(await stat(path)).mtimeMs}`);
			if (entry.isDirectory()) await walk(path);
		}
	};
	await walk(dir);
	return rows;
}

describe("inspectBoardFolder: no board", () => {
	test("an empty folder holds no board and writes nothing", async () => {
		const dir = await freshDir();

		const result = await inspectBoardFolder(dir);

		expect(result).toEqual({
			path: dir,
			exists: true,
			isGitRepo: false,
			location: "none",
			boardYaml: null,
			valid: false,
			error: null,
			key: null,
			types: [],
			statusRoles: null,
			statusMapError: null,
		});
		expect(await readdir(dir)).toEqual([]);
	});

	test("a folder that does not exist is reported, not thrown", async () => {
		const dir = await freshDir();

		const result = await inspectBoardFolder(join(dir, "missing"));

		expect(result).toEqual({
			path: join(dir, "missing"),
			exists: false,
			isGitRepo: false,
			location: "none",
			boardYaml: null,
			valid: false,
			error: null,
			key: null,
			types: [],
			statusRoles: null,
			statusMapError: null,
		});
	});
});

describe("inspectBoardFolder: a board at the folder root", () => {
	test("summarizes every type: layout, document counts, statuses and counts", async () => {
		const dir = await freshDir();
		await writeRootBoard(dir);
		await mkdir(join(dir, ".git"));

		const result = await inspectBoardFolder(dir);

		expect(result.path).toBe(dir);
		expect(result.exists).toBe(true);
		expect(result.isGitRepo).toBe(true);
		expect(result.location).toBe("root");
		expect(result.boardYaml).toBe(join(dir, "board.yaml"));
		expect(result.valid).toBe(true);
		expect(result.error).toBeNull();
		expect(result.key).toBe("POOT");
		expect(result.types.map((type) => type.name)).toEqual(["task", "note"]);
		expect(result.types[0]).toEqual({
			name: "task",
			dir: "tasks",
			layout: "flat",
			documents: 4,
			statusField: "status",
			statuses: ["planned", "doing", "done"],
			statusCounts: { planned: 1, doing: 2, done: 1 },
		});
		// A type without a `status` enum still reports a zeroed summary.
		expect(result.types[1]).toEqual({
			name: "note",
			dir: "notes",
			layout: "flat",
			documents: 1,
			statusField: null,
			statuses: [],
			statusCounts: {},
		});
	});
});

describe("inspectBoardFolder: status map", () => {
	test("a board whose statuses need a map reports the attach error", async () => {
		const dir = await freshDir();
		await writeRootBoard(dir);

		const result = await inspectBoardFolder(dir);

		expect(result.valid).toBe(true);
		expect(result.statusRoles).toBeNull();
		expect(result.statusMapError).toContain("x-mfw-daemon");
	});

	test("a template board reports each status's daemon role", async () => {
		const dir = await freshDir();
		await writeFile(
			join(dir, "board.yaml"),
			(getBoardTemplate("kanban") as BoardTemplate).yaml("KAN"),
		);

		const result = await inspectBoardFolder(dir);

		expect(result.statusMapError).toBeNull();
		expect(result.statusRoles).toEqual({
			todo: "ready",
			doing: "in_progress",
			review: "review",
			done: "done",
		});
	});
});

describe("inspectBoardFolder: the legacy .mfw board", () => {
	test("finds .mfw/board.yaml and counts a directory layout", async () => {
		const dir = await freshDir();
		await mkdir(join(dir, ".mfw"), { recursive: true });
		await writeFile(join(dir, ".mfw", "board.yaml"), LEGACY_BOARD_YAML);
		await writeDoc(join(dir, ".mfw", "tasks", "TSK-1", "task.md"), "TSK-1", {
			title: "first",
			status: "open",
		});
		await writeDoc(join(dir, ".mfw", "tasks", "TSK-2", "task.md"), "TSK-2", {
			title: "second",
			status: "closed",
		});

		const result = await inspectBoardFolder(dir);

		expect(result.location).toBe("legacy-mfw");
		expect(result.boardYaml).toBe(join(dir, ".mfw", "board.yaml"));
		expect(result.valid).toBe(true);
		expect(result.key).toBe("TSK");
		expect(result.types).toEqual([
			{
				name: "task",
				dir: "tasks",
				layout: "directory",
				documents: 2,
				statusField: "status",
				statuses: ["open", "closed"],
				statusCounts: { open: 1, closed: 1 },
			},
		]);
	});
});

describe("inspectBoardFolder: an ambiguous folder", () => {
	test("a board.yaml in both places reports ambiguous and reads the root one", async () => {
		const dir = await freshDir();
		await writeRootBoard(dir);
		await mkdir(join(dir, ".mfw"), { recursive: true });
		await writeFile(
			join(dir, ".mfw", "board.yaml"),
			LEGACY_BOARD_YAML, // key TSK: the root one (key POOT) must win
		);

		const result = await inspectBoardFolder(dir);

		expect(result.location).toBe("ambiguous");
		expect(result.boardYaml).toBe(join(dir, "board.yaml"));
		expect(result.valid).toBe(true);
		expect(result.key).toBe("POOT");
	});
});

describe("inspectBoardFolder: a broken board.yaml", () => {
	test("reports the config error with no types instead of throwing", async () => {
		const dir = await freshDir();
		await writeFile(join(dir, "board.yaml"), "mfw: 1\ntypes: [oops\n");

		const result = await inspectBoardFolder(dir);

		expect(result.location).toBe("root");
		expect(result.boardYaml).toBe(join(dir, "board.yaml"));
		expect(result.valid).toBe(false);
		expect(result.error).toBeTruthy();
		expect(result.types).toEqual([]);
		expect(result.key).toBeNull();
	});
});

describe("inspectBoardFolder: read-only", () => {
	test("leaves the folder byte-for-byte untouched", async () => {
		const dir = await freshDir();
		await writeRootBoard(dir);
		const before = await snapshot(dir);

		await inspectBoardFolder(dir);

		expect(await snapshot(dir)).toEqual(before);
	});
});
