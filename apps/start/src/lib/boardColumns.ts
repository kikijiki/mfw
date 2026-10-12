/**
 * BOARD column collapse state. Per device, per project, in localStorage (like
 * lib/seen.ts and the live resume cursor in lib/live.ts); the daemon does not
 * need it.
 */

const KEY_PREFIX = "mfw:v2:board:collapsed:";

/** `null` means nothing has been stored yet; the caller falls back to a default. */
export function readCollapsedColumns(project: string): string[] | null {
	return readList(KEY_PREFIX + project);
}

function readList(key: string): string[] | null {
	if (typeof window === "undefined") return null;
	try {
		const raw = window.localStorage.getItem(key);
		if (raw === null) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((v): v is string => typeof v === "string");
	} catch {
		return null;
	}
}

export function writeCollapsedColumns(
	project: string,
	collapsed: readonly string[],
): void {
	writeList(KEY_PREFIX + project, collapsed);
}

function writeList(key: string, list: readonly string[]): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(key, JSON.stringify(list));
	} catch {
		// private window or blocked storage: the choice just is not remembered
	}
}

const EXPANDED_PREFIX = "mfw:v2:board:expanded-empty:";

/** Empty columns the person opened on purpose (empty ones are rails otherwise). */
export function readExpandedEmpty(project: string): string[] {
	return readList(EXPANDED_PREFIX + project) ?? [];
}

export function writeExpandedEmpty(
	project: string,
	expanded: readonly string[],
): void {
	writeList(EXPANDED_PREFIX + project, expanded);
}

/** How the board lays its statuses out: full-width swimlanes (default) or the classic columns. */
export type BoardLayout = "lanes" | "columns";

export const DEFAULT_BOARD_LAYOUT: BoardLayout = "lanes";

const LAYOUT_PREFIX = "mfw:v2:board:layout:";

export function parseBoardLayout(value: unknown): BoardLayout {
	return value === "columns" || value === "lanes"
		? value
		: DEFAULT_BOARD_LAYOUT;
}

/** The project's remembered layout; the default when nothing (or nothing usable) is stored. */
export function readBoardLayout(project: string): BoardLayout {
	if (typeof window === "undefined") return DEFAULT_BOARD_LAYOUT;
	try {
		return parseBoardLayout(
			window.localStorage.getItem(LAYOUT_PREFIX + project),
		);
	} catch {
		return DEFAULT_BOARD_LAYOUT;
	}
}

export function writeBoardLayout(project: string, layout: BoardLayout): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(LAYOUT_PREFIX + project, layout);
	} catch {
		// private window or blocked storage: the choice just is not remembered
	}
}
