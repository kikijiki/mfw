import { afterEach, describe, expect, test } from "bun:test";
import {
	BOARD_SORT_OPTIONS,
	BOARD_SORT_STORAGE_KEY,
	DEFAULT_BOARD_SORT,
	readBoardSort,
	sortBoardTasks,
	writeBoardSort,
} from "./boardSort";

interface TestTask {
	id: string;
	priority: string;
	createdAt: Date;
	updatedAt: Date;
	claimedByRunId: string | null;
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
	if (originalWindow)
		Object.defineProperty(globalThis, "window", originalWindow);
	else Reflect.deleteProperty(globalThis, "window");
});

function task(
	id: string,
	priority: string,
	createdAt: string,
	updatedAt: string,
	claimedByRunId: string | null = null,
): TestTask {
	return {
		id,
		priority,
		createdAt: new Date(createdAt),
		updatedAt: new Date(updatedAt),
		claimedByRunId,
	};
}

const fixtures = [
	task("MFW-10", "medium", "2025-01-02", "2025-02-01"),
	task("MFW-2", "critical", "2025-01-03", "2025-01-01"),
	task("MFW-3", "high", "2025-01-01", "2025-03-01"),
	task("MFW-1", "low", "2025-01-03", "2025-03-01"),
];

describe("board sorting", () => {
	test("defines all supported choices and defaults to natural task ID", () => {
		expect(BOARD_SORT_OPTIONS.map((option) => option.value)).toEqual([
			"task-id-asc",
			"priority-desc",
			"created-desc",
			"created-asc",
			"updated-desc",
			"updated-asc",
		]);
		expect(BOARD_SORT_OPTIONS.map((option) => option.label)).toEqual([
			"Task ID: ascending",
			"Priority: high to low",
			"Created: newest first",
			"Created: oldest first",
			"Updated: newest first",
			"Updated: oldest first",
		]);
		expect(DEFAULT_BOARD_SORT).toBe("task-id-asc");
		expect(
			sortBoardTasks(fixtures, "task-id-asc").map((row) => row.id),
		).toEqual(["MFW-1", "MFW-2", "MFW-3", "MFW-10"]);
	});

	test("sorts priority high to low and breaks ties by task ID", () => {
		const rows = [
			...fixtures,
			task("MFW-4", "critical", "2025-01-01", "2025-01-01"),
		];
		expect(sortBoardTasks(rows, "priority-desc").map((row) => row.id)).toEqual([
			"MFW-2",
			"MFW-4",
			"MFW-3",
			"MFW-10",
			"MFW-1",
		]);
	});

	test("sorts created and updated timestamps in both directions with ID ties", () => {
		expect(
			sortBoardTasks(fixtures, "created-desc").map((row) => row.id),
		).toEqual(["MFW-1", "MFW-2", "MFW-10", "MFW-3"]);
		expect(
			sortBoardTasks(fixtures, "created-asc").map((row) => row.id),
		).toEqual(["MFW-3", "MFW-10", "MFW-1", "MFW-2"]);
		expect(
			sortBoardTasks(fixtures, "updated-desc").map((row) => row.id),
		).toEqual(["MFW-1", "MFW-3", "MFW-10", "MFW-2"]);
		expect(
			sortBoardTasks(fixtures, "updated-asc").map((row) => row.id),
		).toEqual(["MFW-2", "MFW-10", "MFW-1", "MFW-3"]);
	});

	test("keeps all claimed tasks first and sorts within each partition", () => {
		const rows = [
			task("MFW-1", "critical", "2025-01-04", "2025-01-04"),
			task("MFW-9", "low", "2025-01-01", "2025-01-01", "run-9"),
			task("MFW-2", "high", "2025-01-03", "2025-01-03"),
			task("MFW-8", "critical", "2025-01-02", "2025-01-02", "run-8"),
		];
		expect(sortBoardTasks(rows, "priority-desc").map((row) => row.id)).toEqual([
			"MFW-8",
			"MFW-9",
			"MFW-1",
			"MFW-2",
		]);
	});
});

describe("board sort persistence", () => {
	test("uses one project-independent key and falls back for missing or unsupported values", () => {
		const values = new Map<string, string>();
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				localStorage: {
					getItem: (key: string) => values.get(key) ?? null,
					setItem: (key: string, value: string) => values.set(key, value),
				},
			},
		});

		expect(readBoardSort()).toBe(DEFAULT_BOARD_SORT);
		values.set(BOARD_SORT_STORAGE_KEY, "obsolete-sort");
		expect(readBoardSort()).toBe(DEFAULT_BOARD_SORT);
		writeBoardSort("created-desc");
		expect([...values.entries()]).toEqual([
			[BOARD_SORT_STORAGE_KEY, "created-desc"],
		]);
		expect(BOARD_SORT_STORAGE_KEY.endsWith(":")).toBe(false);
		expect(readBoardSort()).toBe("created-desc");
	});

	test("storage access failures never escape", () => {
		Object.defineProperty(globalThis, "window", {
			configurable: true,
			value: {
				localStorage: {
					getItem: () => {
						throw new Error("disabled");
					},
					setItem: () => {
						throw new Error("disabled");
					},
				},
			},
		});

		expect(readBoardSort()).toBe(DEFAULT_BOARD_SORT);
		expect(() => writeBoardSort("updated-asc")).not.toThrow();
	});
});
