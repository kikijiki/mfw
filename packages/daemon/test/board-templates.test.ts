import { describe, expect, test } from "bun:test";
import { parseBoardConfig } from "@mfw/board-core";
import { parse as parseYaml } from "yaml";
import { BOARD_TEMPLATES, getBoardTemplate } from "../src/board-templates.ts";

const ROLES = [
	"draft",
	"backlog",
	"ready",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
] as const;

type StatusMap = Record<string, readonly string[]>;

/** One template's yaml with the `x-mfw-daemon` block split off: board-core
 * rejects it (strict schema), so tests parse the board without it and check
 * the block itself as yaml text. */
function split(
	templateId: string,
	taskKey = "ABC",
): {
	doc: unknown;
	statusMap: StatusMap;
} {
	const template = getBoardTemplate(templateId);
	if (!template) throw new Error(`missing template '${templateId}'`);
	const doc = parseYaml(template.yaml(taskKey)) as Record<string, unknown>;
	const extension = doc["x-mfw-daemon"] as
		| { statusMap?: StatusMap }
		| undefined;
	if (!extension?.statusMap) {
		throw new Error(`'${templateId}': no x-mfw-daemon statusMap`);
	}
	delete doc["x-mfw-daemon"];
	return { doc, statusMap: extension.statusMap };
}

/** Every status mapped by exactly one role, and every mapped value a real status. */
function statusMapProblems(
	statuses: readonly string[],
	statusMap: StatusMap,
): string[] {
	const problems: string[] = [];
	const owners = new Map<string, string[]>();
	for (const role of ROLES) {
		for (const status of statusMap[role] ?? []) {
			owners.set(status, [...(owners.get(status) ?? []), role]);
		}
	}
	for (const status of statuses) {
		const by = owners.get(status) ?? [];
		if (by.length === 0) {
			problems.push(`status '${status}' is mapped by no role`);
		}
		if (by.length > 1) {
			problems.push(`status '${status}' is mapped by ${by.join(", ")}`);
		}
	}
	for (const [status, by] of owners) {
		if (!statuses.includes(status)) {
			problems.push(`role '${by[0]}' maps '${status}', which is not a status`);
		}
	}
	for (const role of Object.keys(statusMap)) {
		if (!(ROLES as readonly string[]).includes(role)) {
			problems.push(`unknown role '${role}'`);
		}
	}
	return problems;
}

describe("the board template catalogue", () => {
	test("ids are unique and getBoardTemplate resolves each one", () => {
		expect(BOARD_TEMPLATES.map((t) => t.id)).toEqual([
			"mfw-default",
			"kanban",
			"planning",
			"jira-like",
		]);
		expect(new Set(BOARD_TEMPLATES.map((t) => t.id)).size).toBe(
			BOARD_TEMPLATES.length,
		);
		for (const template of BOARD_TEMPLATES) {
			expect(getBoardTemplate(template.id)).toBe(template);
		}
		expect(getBoardTemplate("nope")).toBeUndefined();
	});

	for (const template of BOARD_TEMPLATES) {
		test(`${template.id}: yaml('ABC') parses without the x-mfw-daemon block, task statuses match`, () => {
			const { doc, statusMap } = split(template.id);
			const config = parseBoardConfig(doc);
			expect(Object.keys(config.types)).toEqual(["task", "adr"]);
			const status = config.types.task?.fields.status;
			expect(status?.kind).toBe("enum");
			expect(status?.kind === "enum" ? status.values : []).toEqual(
				template.statuses,
			);
			// The workflow the catalogue declares: classes, ready columns, transitions.
			const workflow = config.types.task?.workflow;
			expect(workflow?.classes.terminal.length ?? 0).toBeGreaterThan(0);
			expect(workflow?.ready.dependsOn).toBe("depends_on");
			expect(Object.keys(workflow?.transitions ?? {}).length).toBeGreaterThan(
				0,
			);
			// The id key really is the one asked for, in both types.
			const yaml = template.yaml("ABC");
			expect(yaml).toContain("key: ABC");
			expect(yaml.match(/key: ABC/g)?.length).toBe(2);
			// And the block itself is well-formed.
			expect(Object.keys(statusMap).sort()).toEqual([...ROLES].sort());
			expect(statusMapProblems(template.statuses, statusMap)).toEqual([]);
		});

		test(`${template.id}: a statusMap that omits one of its statuses fails the coverage check`, () => {
			const { statusMap } = split(template.id);
			const mutated: StatusMap = structuredClone(statusMap);
			const role = ROLES.find((r) => (mutated[r] ?? []).length > 0);
			expect(role).toBeTruthy();
			const dropped = (mutated[role as (typeof ROLES)[number]] ?? [])[0];
			expect(dropped).toBeTruthy();
			mutated[role as (typeof ROLES)[number]] = (
				mutated[role as (typeof ROLES)[number]] ?? []
			).filter((status) => status !== dropped);
			expect(statusMapProblems(template.statuses, mutated)).toEqual([
				`status '${dropped}' is mapped by no role`,
			]);
		});
	}
});
