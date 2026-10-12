import { describe, expect, test } from "bun:test";
import { parseBoardConfig, type TypeSpec } from "@mfw/board-core";
import { parseStatusMap, StatusMapError } from "../src/board-status-map.ts";

/**
 * The planning board: a board whose statuses are not the daemon's eight, and
 * which declares how to read them in its own `board.yaml`. Every translation
 * the daemon does at the board boundary goes through this map, so these are
 * the rules the rest of the daemon relies on.
 */

const PLANNING_STATUS_MAP: Record<string, readonly string[]> = {
	ready: ["planned"],
	in_progress: ["doing"],
	done: ["done"],
	blocked: ["deferred"],
	archived: ["dropped", "retired"],
	backlog: ["planned"],
};

const PLANNING_YAML: Record<string, unknown> = {
	mfw: 1,
	types: {
		task: {
			layout: "flat",
			dir: "tasks",
			id: { strategy: "own-sequence", key: "POOT" },
			fields: {
				title: {},
				status: {
					values: [
						"planned",
						"doing",
						"done",
						"deferred",
						"dropped",
						"retired",
					],
					default: "planned",
				},
			},
		},
	},
	"x-mfw-daemon": { statusMap: PLANNING_STATUS_MAP },
};

const MFW_STATUSES = [
	"draft",
	"backlog",
	"ready",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
];

function mapOf(raw: Record<string, unknown>) {
	const config = parseBoardConfig(raw);
	return parseStatusMap(config.extensions, config.types.task as TypeSpec);
}

const planning = () => mapOf(structuredClone(PLANNING_YAML));

describe("reading a board status", () => {
	test("planned reads as ready: it is listed first under both ready and backlog", () => {
		expect(planning().toCanonical("planned")).toBe("ready");
	});

	test("dropped and retired both read as archived", () => {
		const map = planning();
		expect(map.toCanonical("dropped")).toBe("archived");
		expect(map.toCanonical("retired")).toBe("archived");
	});

	test("a value listed second loses to a role that listed it first", () => {
		const map = mapOf({
			...structuredClone(PLANNING_YAML),
			"x-mfw-daemon": {
				statusMap: { ready: ["done", "planned"], backlog: ["planned"] },
			},
		});
		expect(map.toCanonical("planned")).toBe("backlog");
	});

	test("with no first-listing role, the fixed priority decides", () => {
		const map = mapOf({
			...structuredClone(PLANNING_YAML),
			"x-mfw-daemon": {
				statusMap: {
					ready: ["done", "planned"],
					backlog: ["deferred", "planned"],
				},
			},
		});
		expect(map.toCanonical("planned")).toBe("ready");
	});

	test("a board status no role lists cannot be read", () => {
		const map = mapOf({
			...structuredClone(PLANNING_YAML),
			"x-mfw-daemon": {
				statusMap: { ready: ["planned"], in_progress: ["doing"] },
			},
		});
		expect(() => map.toCanonical("dropped")).toThrow(StatusMapError);
		expect(() => map.toCanonical("dropped")).toThrow(/x-mfw-daemon\.statusMap/);
	});
});

describe("writing a daemon status", () => {
	test("a role writes the first value of its list", () => {
		const map = planning();
		expect(map.toBoard("in_progress")).toBe("doing");
		expect(map.toBoard("archived")).toBe("dropped");
		expect(map.toBoard("done")).toBe("done");
	});

	test("a role with no entry cannot be written, and the error names the entry to add", () => {
		const map = planning();
		for (const role of ["draft", "review"] as const) {
			expect(() => map.toBoard(role)).toThrow(StatusMapError);
			expect(() => map.toBoard(role)).toThrow(new RegExp(`'${role}'`));
			expect(() => map.toBoard(role)).toThrow(/x-mfw-daemon\.statusMap/);
			expect(() => map.toBoard(role)).toThrow(/Add/);
		}
	});

	test("an empty list is no board equivalent either", () => {
		const map = mapOf({
			...structuredClone(PLANNING_YAML),
			"x-mfw-daemon": {
				statusMap: { ...PLANNING_STATUS_MAP, draft: [] },
			},
		});
		expect(() => map.toBoard("draft")).toThrow(/'draft'/);
	});
});

describe("with no statusMap", () => {
	test("a board already speaking mfw's statuses is the identity", () => {
		const map = mapOf({
			mfw: 1,
			types: {
				task: {
					layout: "flat",
					dir: "tasks",
					id: { strategy: "own-sequence", key: "MFW" },
					fields: {
						title: {},
						status: { values: MFW_STATUSES, default: "backlog" },
					},
				},
			},
		});
		expect(map.toCanonical("review")).toBe("review");
		expect(map.toBoard("in_progress")).toBe("in_progress");
	});

	test("a board with its own statuses fails, listing them and the map to add", () => {
		const raw = structuredClone(PLANNING_YAML) as Record<string, unknown>;
		delete raw["x-mfw-daemon"];
		expect(() => mapOf(raw)).toThrow(StatusMapError);
		expect(() => mapOf(raw)).toThrow(/'planned'/);
		expect(() => mapOf(raw)).toThrow(/'doing'/);
		expect(() => mapOf(raw)).toThrow(/'deferred'/);
		// 'done' already is an mfw status, so it is not unmapped.
		expect(() => mapOf(raw)).not.toThrow(/'done'/);
		expect(() => mapOf(raw)).toThrow(/x-mfw-daemon:\n {2}statusMap:/);
		expect(() => mapOf(raw)).toThrow(/ready: \[/);
	});
});

describe("map validation", () => {
	test("a role that is not one of the eight statuses is refused", () => {
		expect(() =>
			mapOf({
				...structuredClone(PLANNING_YAML),
				"x-mfw-daemon": { statusMap: { shipped: ["planned"] } },
			}),
		).toThrow(/'shipped' is not an mfw status/);
	});

	test("a value the status field does not declare is refused", () => {
		expect(() =>
			mapOf({
				...structuredClone(PLANNING_YAML),
				"x-mfw-daemon": { statusMap: { ready: ["parked"] } },
			}),
		).toThrow(/'parked' is not a value of the task type's 'status' field/);
	});

	test("a statusMap that is not a mapping is refused", () => {
		expect(() =>
			mapOf({
				...structuredClone(PLANNING_YAML),
				"x-mfw-daemon": { statusMap: "ready" },
			}),
		).toThrow(/statusMap must be a mapping/);
	});
});
