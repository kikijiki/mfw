/**
 * The HISTORY since-marker. Per device, per project, advanced ONLY by the
 * explicit "Caught up" button, not by navigation.
 *
 * Separate from the live channel's applied-seq (`mfw:v2:live:seq:<project>`,
 * lib/live.ts): that tracks what the cache consumed, this tracks what the
 * human read.
 */

const KEY_PREFIX = "mfw:v2:history:seen:";

export function readSeenSeq(project: string): number {
	if (typeof window === "undefined") return 0;
	const raw = window.localStorage.getItem(KEY_PREFIX + project);
	const n = raw === null ? Number.NaN : Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function writeSeenSeq(project: string, seq: number): void {
	if (typeof window === "undefined") return;
	window.localStorage.setItem(KEY_PREFIX + project, String(seq));
}

export function readSeenMap(
	projects: readonly string[],
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const p of projects) out[p] = readSeenSeq(p);
	return out;
}
