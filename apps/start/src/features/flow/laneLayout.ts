/**
 * Marker-lane layout for one Flow row, pure (no React, no clock): where each
 * point event sits on the time axis, and which events are too close to be
 * told apart and become one counted cluster.
 *
 * The rule the lane keeps: no two things in a lane are ever drawn on the same
 * pixels. Events whose x positions are closer than `MARK_PITCH` chain into one
 * cluster, so the clusters' centres are at least `MARK_PITCH` apart and a
 * 16px icon (or a count badge) never touches its neighbour. Zooming in moves
 * events apart in px and splits clusters; nothing here depends on the data's
 * density, only on pixels.
 */

/** Centre-to-centre distance below which events are one cluster (mark 16px + 6px air). */
export const MARK_PITCH = 22;
/** Half a mark: the closest a centre may sit to the lane's ends, so nothing is clipped. */
export const MARK_EDGE = 8;

export interface LaneItem {
	/** Stable identity (tests and React keys). */
	key: string;
	/** Event time, ms. */
	at: number;
}

export interface MarkCluster<T extends LaneItem> {
	/** The first member's key: stable while the cluster's membership is. */
	key: string;
	/** Centre in px from the lane's left edge. */
	x: number;
	/** Members in time order (never empty). */
	members: T[];
}

interface Axis {
	from: number;
	to: number;
	width: number;
}

/**
 * Place `items` on the axis and cluster them. Items outside `[from, to]` are
 * dropped; positions are clamped so a mark at the very edge is still whole.
 *
 * Guarantees (property-tested): every kept item is in exactly one cluster;
 * clusters are ordered by x; adjacent clusters are `pitch` or more apart.
 */
export function layoutMarks<T extends LaneItem>(
	items: readonly T[],
	axis: Axis,
	pitch: number = MARK_PITCH,
	edge: number = MARK_EDGE,
): MarkCluster<T>[] {
	const span = Math.max(1, axis.to - axis.from);
	const lo = Math.min(edge, axis.width / 2);
	const hi = Math.max(lo, axis.width - edge);
	const placed = items
		.filter((i) => i.at >= axis.from && i.at <= axis.to)
		.map((item) => ({
			item,
			x: Math.min(
				hi,
				Math.max(lo, ((item.at - axis.from) / span) * axis.width),
			),
		}))
		.sort((a, b) => a.x - b.x || a.item.at - b.item.at);

	const out: { items: T[]; xs: number[] }[] = [];
	let prevX = Number.NEGATIVE_INFINITY;
	for (const p of placed) {
		const last = out.at(-1);
		if (last && p.x - prevX < pitch) {
			last.items.push(p.item);
			last.xs.push(p.x);
		} else out.push({ items: [p.item], xs: [p.x] });
		prevX = p.x;
	}
	return out.map((c) => {
		const members = [...c.items].sort((a, b) => a.at - b.at);
		return {
			key: (members[0] as T).key,
			x: c.xs.reduce((a, b) => a + b, 0) / c.xs.length,
			members,
		};
	});
}

/** A cluster's members grouped by `kind`, most frequent first (the badge's tint). */
export function kindsOf<T extends LaneItem & { kind: string }>(
	cluster: MarkCluster<T>,
): { kind: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const m of cluster.members)
		counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
	return [...counts.entries()]
		.map(([kind, count]) => ({ kind, count }))
		.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/**
 * The window that frames activity: from the earliest of `stamps` (padded) to
 * `now`, never narrower than `minMs` nor wider than `maxMs`. Only stamps in
 * the last `lookbackMs` count, so one run from last month does not squeeze
 * today's work against the right edge. With no stamps it is `fallbackMs`.
 */
export function fitWindowMs(
	stamps: readonly number[],
	now: number,
	opts: {
		minMs?: number;
		maxMs?: number;
		lookbackMs?: number;
		fallbackMs?: number;
	} = {},
): number {
	const minMs = opts.minMs ?? 15 * 60_000;
	const maxMs = opts.maxMs ?? 7 * 24 * 3_600_000;
	const lookbackMs = opts.lookbackMs ?? 24 * 3_600_000;
	const fallbackMs = opts.fallbackMs ?? 2 * 3_600_000;
	let first: number | null = null;
	for (const s of stamps) {
		if (!Number.isFinite(s) || s > now || now - s > lookbackMs) continue;
		if (first === null || s < first) first = s;
	}
	if (first === null) return fallbackMs;
	const used = now - first;
	// 6% of air on the left so the first event is not on the edge.
	const padded = used + Math.max(used * 0.06, 60_000);
	return Math.min(maxMs, Math.max(minMs, Math.ceil(padded / 60_000) * 60_000));
}
