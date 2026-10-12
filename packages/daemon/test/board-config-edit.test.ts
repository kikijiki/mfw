import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStore, loadBoardConfig } from "@mfw/board-core";
import {
	applyBoardConfigEdit,
	diffLines,
	patchFromTemplate,
	planBoardConfigEdit,
	readBoardConfig,
} from "../src/board-config-edit.ts";
import { parseStatusMap } from "../src/board-status-map.ts";
import { getBoardTemplate } from "../src/board-templates.ts";
import { git } from "../src/git.ts";

const dirs: string[] = [];
afterAll(async () => {
	for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A planning-template board in a git repo, with one task per given status. */
async function makeBoard(
	statuses: string[] = [],
	transform: (yaml: string) => string = (y) => y,
): Promise<{ dir: string; ids: string[] }> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-board-edit-"));
	dirs.push(dir);
	const yaml = transform(
		`# my board\n${(getBoardTemplate("planning") as { yaml(k: string): string }).yaml("PLAN")}`,
	);
	await writeFile(join(dir, "board.yaml"), yaml);
	const ids: string[] = [];
	if (statuses.length > 0) {
		const config = await loadBoardConfig(join(dir, "board.yaml"));
		const store = new BoardStore(dir, config);
		for (const status of statuses) {
			const doc = await store.createDocument("task", {
				fields: { title: `t-${status}`, status },
			});
			ids.push(doc.id);
		}
	}
	await writeFile(join(dir, ".gitignore"), ".board/\n");
	await git(["init", "-q", "-b", "main"], dir);
	await git(["add", "-A"], dir);
	await git(
		["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
		dir,
	);
	return { dir, ids };
}

const kanbanStatuses = [
	{ value: "planned", role: "ready" as const },
	{ value: "doing", role: "in_progress" as const },
	{ value: "done", role: "done" as const },
	{ value: "deferred", role: "blocked" as const },
	{ value: "dropped", role: "archived" as const },
	{ value: "retired", role: "archived" as const },
];

describe("board-config-edit", () => {
	test("read returns statuses with roles and task counts", async () => {
		const { dir } = await makeBoard(["planned", "planned", "doing"]);
		const view = await readBoardConfig(dir);
		expect(view.statuses.map((s) => [s.value, s.role, s.tasks])).toEqual([
			["planned", "ready", 2],
			["doing", "in_progress", 1],
			["done", "done", 0],
			["deferred", "blocked", 0],
			["dropped", "archived", 0],
			["retired", "archived", 0],
		]);
		expect(view.taskTypes).toContain("epic");
		expect(view.layout).toBe("flat");
		expect(view.unsupported).toBeNull();
	});

	test("adding a status and changing a role rewrites the map the daemon parses", async () => {
		const { dir } = await makeBoard();
		const result = await applyBoardConfigEdit(
			dir,
			{
				statuses: [
					...kanbanStatuses.slice(0, 2),
					{ value: "qa", role: "review" },
					...kanbanStatuses.slice(2),
				],
			},
			{ commit: false },
		);
		expect(result.ok).toBe(true);
		const config = await loadBoardConfig(join(dir, "board.yaml"));
		const task = config.types.task;
		if (!task) throw new Error("no task type");
		const map = parseStatusMap(config.extensions, task);
		expect(map.toCanonical("qa")).toBe("review");
		expect(map.toBoard("review")).toBe("qa");
		expect(map.toCanonical("planned")).toBe("ready");
		expect(map.toBoard("archived")).toBe("dropped");
		expect(map.toCanonical("retired")).toBe("archived");
		const status = task.fields.status;
		expect(status?.kind === "enum" && status.values).toEqual([
			"planned",
			"doing",
			"qa",
			"done",
			"deferred",
			"dropped",
			"retired",
		]);
		// The new status joined the workflow's live class.
		expect(task.workflow?.classes.live).toContain("qa");
	});

	test("comments and unknown keys survive an edit", async () => {
		const { dir } = await makeBoard([], (y) =>
			`${y}\nx-other:\n  keep: me # trailing\n`.replace(
				"    layout: flat",
				"    # tasks live flat\n    layout: flat",
			),
		);
		const result = await applyBoardConfigEdit(
			dir,
			{ maxDepth: undefined, types: ["implementation", "spike", "epic"] },
			{ commit: false },
		);
		expect(result.ok).toBe(true);
		const text = await readFile(join(dir, "board.yaml"), "utf8");
		expect(text).toContain("# my board");
		expect(text).toContain("# tasks live flat");
		expect(text).toContain("x-other:\n  keep: me # trailing");
		expect(text).not.toContain("maintenance]");
		const view = await readBoardConfig(dir);
		expect(view.taskTypes).toEqual(["implementation", "spike", "epic"]);
	});

	test("removing a status that tasks use is refused, naming them, and writes nothing", async () => {
		const { dir, ids } = await makeBoard(["deferred", "planned"]);
		const before = await readFile(join(dir, "board.yaml"), "utf8");
		const result = await applyBoardConfigEdit(dir, {
			statuses: kanbanStatuses.filter((s) => s.value !== "deferred"),
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.orphans).toEqual([
			{ status: "deferred", ids: [ids[0] as string] },
		]);
		expect(result.errors.join(" ")).toContain(ids[0] as string);
		expect(await readFile(join(dir, "board.yaml"), "utf8")).toBe(before);
	});

	test("remapTo rewrites the tasks, drops the status and commits board.yaml and the tasks", async () => {
		const { dir, ids } = await makeBoard(["deferred", "planned"]);
		const result = await applyBoardConfigEdit(
			dir,
			{
				statuses: kanbanStatuses.filter((s) => s.value !== "deferred"),
				remapTo: { deferred: "planned" },
			},
			{ integrationBranch: "main" },
		);
		if (!result.ok) throw new Error(result.errors.join("\n"));
		if (!result.ok) return;
		expect(result.remaps).toEqual([
			{ id: ids[0] as string, from: "deferred", to: "planned" },
		]);
		expect(result.committed).not.toBeNull();
		const config = await loadBoardConfig(join(dir, "board.yaml"));
		const store = new BoardStore(dir, config);
		expect(
			(await store.readDocument("task", ids[0] as string))?.fields.status,
		).toBe("planned");
		const text = await readFile(join(dir, "board.yaml"), "utf8");
		expect(text).not.toContain("deferred");
		// The transitions that needed `deferred` are gone, reported, not silent.
		expect(result.warnings.join("\n")).toContain("transition 'defer'");
		const status = await git(["status", "--porcelain"], dir);
		expect(status.stdout).toBe("");
		const log = await git(["log", "--format=%s", "-n", "1"], dir);
		expect(log.stdout).toContain("board config edited (1 task remapped)");
	});

	test("a rename moves the tasks and keeps the status in the workflow", async () => {
		const { dir, ids } = await makeBoard(["doing"]);
		const result = await applyBoardConfigEdit(
			dir,
			{
				statuses: kanbanStatuses.map((s) =>
					s.value === "doing" ? { ...s, value: "active" } : s,
				),
				renames: { doing: "active" },
			},
			{ commit: false },
		);
		if (!result.ok) throw new Error(result.errors.join("\n"));
		expect(result.remaps).toEqual([
			{ id: ids[0] as string, from: "doing", to: "active" },
		]);
		const config = await loadBoardConfig(join(dir, "board.yaml"));
		const task = config.types.task;
		if (!task) throw new Error("no task type");
		expect(task.workflow?.classes.live).toContain("active");
		expect(task.workflow?.transitions.start?.to).toBe("active");
		expect(task.workflow?.transitions.finish?.from).toEqual(["active"]);
		const map = parseStatusMap(config.extensions, task);
		expect(map.toCanonical("active")).toBe("in_progress");
		const store = new BoardStore(dir, config);
		expect(
			(await store.readDocument("task", ids[0] as string))?.fields.status,
		).toBe("active");
		expect(result.warnings).toEqual([]);
	});

	test("an invalid result is rejected before anything is written", async () => {
		const { dir } = await makeBoard();
		const before = await readFile(join(dir, "board.yaml"), "utf8");
		// 'sprint' has a status role but the board's transitions/classes stay
		// valid; an illegal status name is refused by the patch check.
		const bad = await applyBoardConfigEdit(dir, {
			statuses: [{ value: "no spaces", role: "ready" }],
		});
		expect(bad.ok).toBe(false);
		// A hierarchy limit on a board without hierarchy cannot be applied.
		const noHierarchy = await applyBoardConfigEdit(dir, { maxDepth: 2 });
		expect(noHierarchy.ok).toBe(false);
		// A hierarchy rule selecting a removed task type fails the strict
		// parser: the edit is refused and the disk keeps the old file.
		const withRule = await makeBoard(
			[],
			(y) =>
				`${y.replace(
					"      parent: { ref: task, optional: true }",
					"      parent: { ref: task, optional: true }\n      children: { ref: task, list: true, optional: true }",
				)}
hierarchy:
  parent: parent
  children: children
  maxDepth: 3
  rules:
    - { child: { type: task, where: { type: [spike] } }, parents: [{ type: task, where: { type: [epic] } }] }
    - { child: task, parents: [] }
`,
		);
		const text = await readFile(join(withRule.dir, "board.yaml"), "utf8");
		const result = await applyBoardConfigEdit(withRule.dir, {
			types: ["implementation", "spike"],
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join(" ")).toContain("epic");
		expect(await readFile(join(withRule.dir, "board.yaml"), "utf8")).toBe(text);
		// The depth limit of a declared hierarchy is editable.
		const depth = await applyBoardConfigEdit(
			withRule.dir,
			{ maxDepth: 5 },
			{ commit: false },
		);
		expect(depth.ok).toBe(true);
		expect((await readBoardConfig(withRule.dir)).hierarchy?.maxDepth).toBe(5);
		expect(await readFile(join(dir, "board.yaml"), "utf8")).toBe(before);
	});

	test("planning does not write; the diff shows the change", async () => {
		const { dir } = await makeBoard();
		const before = await readFile(join(dir, "board.yaml"), "utf8");
		const plan = await planBoardConfigEdit(dir, {
			types: ["implementation", "epic"],
		});
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(plan.changed).toBe(true);
		expect(plan.diff.some((l) => l.op === "+")).toBe(true);
		expect(plan.diff.some((l) => l.op === "-")).toBe(true);
		expect(await readFile(join(dir, "board.yaml"), "utf8")).toBe(before);
	});

	test("a type that tasks use cannot be removed", async () => {
		const { dir } = await makeBoard(["planned"]);
		const result = await planBoardConfigEdit(dir, { types: ["spike", "epic"] });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors.join(" ")).toContain("implementation");
	});

	test("patchFromTemplate carries the template's roles and applies", async () => {
		const patch = patchFromTemplate("jira-like");
		expect(patch?.statuses).toEqual([
			{ value: "todo", role: "ready" },
			{ value: "in_progress", role: "in_progress" },
			{ value: "in_review", role: "review" },
			{ value: "blocked", role: "blocked" },
			{ value: "done", role: "done" },
		]);
		const { dir } = await makeBoard();
		const result = await applyBoardConfigEdit(dir, patch ?? {}, {
			commit: false,
		});
		// Existing statuses with no tasks: removed freely, transitions that
		// pointed at them go (reported), the result still parses.
		expect(result.ok).toBe(true);
		const config = await loadBoardConfig(join(dir, "board.yaml"));
		const status = config.types.task?.fields.status;
		expect(status?.kind === "enum" && status.values).toEqual([
			"todo",
			"in_progress",
			"in_review",
			"blocked",
			"done",
		]);
		expect(patchFromTemplate("nope")).toBeNull();
	});

	test("a template over used statuses is refused with the tasks named", async () => {
		const { dir, ids } = await makeBoard(["planned"]);
		const result = await planBoardConfigEdit(
			dir,
			patchFromTemplate("kanban") ?? {},
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.orphans?.[0]?.ids).toEqual([ids[0] as string]);
	});

	test("diffLines marks changed lines with context", () => {
		expect(diffLines("a\nb\nc\nd\ne\nf\ng", "a\nb\nc\nX\ne\nf\ng")).toEqual([
			{ op: " ", text: "b" },
			{ op: " ", text: "c" },
			{ op: "-", text: "d" },
			{ op: "+", text: "X" },
			{ op: " ", text: "e" },
			{ op: " ", text: "f" },
		]);
		expect(diffLines("x", "x")).toEqual([]);
	});
});
