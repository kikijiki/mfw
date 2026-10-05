/**
 * BOARD column collapse state. Per device, per project, in localStorage (like
 * lib/seen.ts and the live resume cursor in lib/live.ts); the daemon does not
 * need it.
 */

const KEY_PREFIX = "mfw:v2:board:collapsed:";

/** `null` means nothing has been stored yet; the caller falls back to a default. */
export function readCollapsedColumns(project: string): string[] | null {
	if (typeof window === "undefined") return null;
	const raw = window.localStorage.getItem(KEY_PREFIX + project);
	if (raw === null) return null;
	try {
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
	if (typeof window === "undefined") return;
	window.localStorage.setItem(KEY_PREFIX + project, JSON.stringify(collapsed));
}
