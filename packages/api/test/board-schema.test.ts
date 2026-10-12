import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOARD_TEMPLATES } from "@mfw/daemon/board-templates";
import { defaultBoardYaml } from "@mfw/daemon/default-board-config";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

const dirs: string[] = [];
afterAll(async () => {
	for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** A project whose board folder holds exactly this `board.yaml`. */
async function schemaFor(yaml: string) {
	const dir = await mkdtemp(join(tmpdir(), "mfw-board-schema-"));
	dirs.push(dir);
	await writeFile(join(dir, "board.yaml"), yaml);
	const svc = { name: "demo", boardDir: dir } as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return createCaller({ orchestrator }).board.schema({ project: "demo" });
}

const template = (id: string) => {
	const t = BOARD_TEMPLATES.find((b) => b.id === id);
	if (!t) throw new Error(`no template ${id}`);
	return t;
};

describe("board.schema", () => {
	test("a mapped planning board returns its six statuses in order with role and writable", async () => {
		const schema = await schemaFor(template("planning").yaml("PLAN"));
		expect(schema.statuses.map((s) => s.value)).toEqual([
			"planned",
			"doing",
			"done",
			"deferred",
			"dropped",
			"retired",
		]);
		expect(
			schema.statuses.map((s) => [s.value, s.role, s.writable, s.order]),
		).toEqual([
			["planned", "ready", true, 0],
			["doing", "in_progress", true, 1],
			["done", "done", true, 2],
			["deferred", "blocked", true, 3],
			// `dropped` is the first archived value; `retired` reads as archived
			// but a write of `archived` never produces it.
			["dropped", "archived", true, 4],
			["retired", "archived", false, 5],
		]);
		expect(schema.statuses.find((s) => s.value === "planned")?.label).toBe(
			"Planned",
		);
		// Terminal: statusClasses.terminal (done, retired) or an archived/done role.
		expect(
			schema.statuses.filter((s) => s.terminal).map((s) => s.value),
		).toEqual(["done", "dropped", "retired"]);
		expect(schema.types.map((t) => t.value)).toEqual([
			"implementation",
			"spike",
			"epic",
			"maintenance",
		]);
	});

	test("a canonical board returns the eight daemon statuses", async () => {
		const schema = await schemaFor(defaultBoardYaml("MFW"));
		expect(schema.statuses.map((s) => s.value)).toEqual([
			"draft",
			"backlog",
			"ready",
			"in_progress",
			"blocked",
			"review",
			"done",
			"archived",
		]);
		expect(schema.statuses.every((s) => s.role === s.value && s.writable)).toBe(
			true,
		);
		expect(schema.statuses.find((s) => s.value === "in_progress")?.label).toBe(
			"In progress",
		);
		expect(schema.layout).toBe("directory");
		expect(schema.hierarchy).toBeNull();
	});

	test("a flat board reports layout flat", async () => {
		const schema = await schemaFor(template("kanban").yaml("KAN"));
		expect(schema.layout).toBe("flat");
		// Kanban expresses no draft/backlog/blocked/archived: roles, not values.
		expect(schema.statuses.map((s) => [s.value, s.role])).toEqual([
			["todo", "ready"],
			["doing", "in_progress"],
			["review", "review"],
			["done", "done"],
		]);
	});

	test("a hierarchy with kind rules reports its kind field, kinds and depth", async () => {
		const yaml = `mfw: 1
types:
  task:
    layout: flat
    dir: tasks
    id: { strategy: own-sequence, key: POOT }
    fields:
      title: {}
      status: { values: [planned, doing, done], default: planned }
      kind: { values: [epic, group, task], default: task }
      parent: { ref: task, optional: true }
      children: { ref: task, list: true, optional: true }
hierarchy:
  parent: parent
  children: children
  maxDepth: 3
  rules:
    - child: { type: task, where: { kind: [epic] } }
      parents: []
    - child: { type: task, where: { kind: [group] } }
      parents: [{ type: task, where: { kind: [epic] } }]
    - child: { type: task, where: { kind: [task] } }
      parents: [{ type: task, where: { kind: [epic, group] } }]
x-mfw-daemon:
  statusMap:
    ready: [planned]
    in_progress: [doing]
    done: [done]
`;
		const schema = await schemaFor(yaml);
		expect(schema.hierarchy).toEqual({
			maxDepth: 3,
			kindField: "kind",
			kinds: ["epic", "group", "task"],
		});
	});
});
