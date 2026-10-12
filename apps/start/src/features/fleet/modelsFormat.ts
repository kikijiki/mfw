/** Pure helpers for the Models view (kept apart from React so they test cheaply). */

export const WINDOWS = [
	{ id: "7d", label: "7 days", days: 7 },
	{ id: "30d", label: "30 days", days: 30 },
	{ id: "all", label: "All time", days: null },
] as const;
export type WindowId = (typeof WINDOWS)[number]["id"];

/** Epoch-ms lower bound for a window, or undefined for all time. */
export function sinceFor(id: WindowId, now: number): number | undefined {
	const w = WINDOWS.find((x) => x.id === id);
	return w?.days ? now - w.days * 86_400_000 : undefined;
}

/** `0.5` → `"50%"`; null (no closed attempts) → an em dash. */
export function formatRate(rate: number | null): string {
	return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** Verdict counts as a stable, compact list: review verdicts first, then the critic's. */
export function verdictList(
	mix: Record<string, number>,
): { label: string; count: number }[] {
	return Object.entries(mix)
		.filter(([, n]) => n > 0)
		.sort(([a], [b]) => {
			const ca = a.startsWith("critic:");
			const cb = b.startsWith("critic:");
			return ca === cb ? a.localeCompare(b) : ca ? 1 : -1;
		})
		.map(([label, count]) => ({ label, count }));
}
