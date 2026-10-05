/**
 * Global, client-only board ordering preference. Unlike column collapse state
 * it is not per project: one choice applies to every board in this browser.
 */

export const BOARD_SORT_STORAGE_KEY = "mfw:v2:board:sort";

export const BOARD_SORT_OPTIONS = [
	{ value: "task-id-asc", label: "Task ID: ascending" },
	{ value: "priority-desc", label: "Priority: high to low" },
	{ value: "created-desc", label: "Created: newest first" },
	{ value: "created-asc", label: "Created: oldest first" },
	{ value: "updated-desc", label: "Updated: newest first" },
	{ value: "updated-asc", label: "Updated: oldest first" },
] as const;

export type BoardSort = (typeof BOARD_SORT_OPTIONS)[number]["value"];

export const DEFAULT_BOARD_SORT: BoardSort = "task-id-asc";

const BOARD_SORT_VALUES = new Set<BoardSort>(
	BOARD_SORT_OPTIONS.map((option) => option.value),
);

export function isBoardSort(value: unknown): value is BoardSort {
	return typeof value === "string" && BOARD_SORT_VALUES.has(value as BoardSort);
}

export function readBoardSort(): BoardSort {
	if (typeof window === "undefined") return DEFAULT_BOARD_SORT;
	try {
		const stored: unknown = window.localStorage.getItem(BOARD_SORT_STORAGE_KEY);
		return isBoardSort(stored) ? stored : DEFAULT_BOARD_SORT;
	} catch {
		// localStorage can be unavailable even when window exists (privacy settings).
		return DEFAULT_BOARD_SORT;
	}
}

export function writeBoardSort(value: BoardSort): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(
			BOARD_SORT_STORAGE_KEY,
			isBoardSort(value) ? value : DEFAULT_BOARD_SORT,
		);
	} catch {
		// Quota and privacy failures: the in-memory selection still works.
	}
}

export interface BoardSortableTask {
	id: string;
	priority: string;
	createdAt: Date | string | number;
	updatedAt: Date | string | number;
	claimedByRunId: string | null | undefined;
}

const TASK_ID_COLLATOR = new Intl.Collator("en", {
	numeric: true,
	sensitivity: "base",
});

/** Natural task-ID order (`MFW-2` before `MFW-10`), with a final exact
 * comparison so even IDs differing only by case have a stable order. */
export function compareTaskIds(a: string, b: string): number {
	const natural = TASK_ID_COLLATOR.compare(a, b);
	if (natural !== 0) return natural;
	return a < b ? -1 : a > b ? 1 : 0;
}

const PRIORITY_RANK: Record<string, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

function timestamp(value: Date | string | number): number {
	const result =
		value instanceof Date ? value.getTime() : new Date(value).getTime();
	return Number.isNaN(result) ? 0 : result;
}

function selectedComparator<T extends BoardSortableTask>(
	choice: BoardSort,
): (a: T, b: T) => number {
	switch (choice) {
		case "priority-desc":
			return (a, b) =>
				(PRIORITY_RANK[a.priority] ?? Number.MAX_SAFE_INTEGER) -
					(PRIORITY_RANK[b.priority] ?? Number.MAX_SAFE_INTEGER) ||
				compareTaskIds(a.id, b.id);
		case "created-desc":
			return (a, b) =>
				timestamp(b.createdAt) - timestamp(a.createdAt) ||
				compareTaskIds(a.id, b.id);
		case "created-asc":
			return (a, b) =>
				timestamp(a.createdAt) - timestamp(b.createdAt) ||
				compareTaskIds(a.id, b.id);
		case "updated-desc":
			return (a, b) =>
				timestamp(b.updatedAt) - timestamp(a.updatedAt) ||
				compareTaskIds(a.id, b.id);
		case "updated-asc":
			return (a, b) =>
				timestamp(a.updatedAt) - timestamp(b.updatedAt) ||
				compareTaskIds(a.id, b.id);
		case "task-id-asc":
			return (a, b) => compareTaskIds(a.id, b.id);
	}
}

/**
 * Claimed work always comes first. The chosen ordering is then applied
 * independently inside both the claimed and unclaimed partitions.
 */
export function sortBoardTasks<T extends BoardSortableTask>(
	tasks: readonly T[],
	choice: BoardSort,
): T[] {
	const compareSelected = selectedComparator(
		isBoardSort(choice) ? choice : DEFAULT_BOARD_SORT,
	);
	return [...tasks].sort((a, b) => {
		const claimPartition =
			Number(b.claimedByRunId != null) - Number(a.claimedByRunId != null);
		return claimPartition || compareSelected(a, b);
	});
}
