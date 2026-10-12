/**
 * The lanes layout's arithmetic, pure so the page and the tests read the same
 * numbers: how tall one tile may be so every lane fits the viewport, how many
 * tiles a lane shows at a width, the wheel-to-horizontal rule, arrow-key focus
 * movement between lanes, and the scroll that keeps a card in view.
 */

/**
 * The one spacing scale of the board's tiles and lane gutters. Everything that
 * pads, gaps or sizes a tile reads these, so a tile, a lane header and a
 * Columns card keep the same rhythm and the layout maths stays honest.
 */
export const SPACE = {
	/** Padding above and below a tile's content (and a lane header's). */
	PAD_Y: 8,
	/** Padding left and right of a tile's content (and a lane header's). */
	PAD_X: 10,
	/** Gap between the rows inside a tile or a gutter. */
	ROW_GAP: 6,
	/** The first row of a tile and the single row of a lane header: id, icons, chevron. */
	ROW_H: 20,
	/** One line of a tile's title. */
	LINE_H: 18,
	/** The meta line under the title (agents, blocked reason, labels). */
	META_H: 16,
} as const;

/** Height of a tile's content block: first row, title lines, then the meta line. */
export function tileContent(lines: 1 | 2, meta = true): number {
	return (
		SPACE.ROW_H +
		SPACE.ROW_GAP +
		lines * SPACE.LINE_H +
		(meta ? SPACE.ROW_GAP + SPACE.META_H : 0)
	);
}

/** The tile height whose padding is exactly `SPACE.PAD_Y` around a content block of `lines` title lines. */
export function tileNeeds(lines: 1 | 2): number {
	return tileContent(lines) + 2 * SPACE.PAD_Y;
}

/** Pixel constants shared by the CSS (as inline styles) and the maths. */
export const LANE = {
	/** The tile is never shorter than this (eight open lanes still fit a 900px viewport): a dense tile, see `tileMetrics`. */
	MIN_TILE: 68,
	/** ...and never taller than this (two title lines): a board with few lanes is not stretched into bands. */
	MAX_TILE: tileNeeds(2),
	/** Used until the stack has been measured (SSR, first paint). */
	DEFAULT_TILE: tileNeeds(1) + 8,
	/** Padding above and below the lane stack. */
	STACK_PAD: 8,
	/** Gap between two lanes. */
	GAP: 4,
	/** A collapsed (header-only) lane. */
	COLLAPSED: 30,
	/** An open lane with no tasks: one header row and a one-line placeholder, no tile. */
	EMPTY_OPEN: SPACE.ROW_H + 2 * SPACE.PAD_Y + 2,
	/** The lane's own border (top and bottom). */
	BORDER: 2,
	/** Padding of the scroller above and below the tiles. */
	STRIP_PAD_Y: 4,
	/** Room a horizontal scrollbar takes inside the lane, only while the strip overflows. */
	SCROLLBAR: 8,
	/** The most an open lane's chrome takes (scrollbar showing): what the budget assumes. */
	CHROME: 2 + 2 * 4 + 8,
	/** Width of a tile. */
	TILE_W: 272,
	/** Gap between tiles, and the scroller's side padding. */
	TILE_GAP: 8,
	/** Width of the fixed header gutter on the left of a lane. */
	GUTTER: 172,
	/** Tiles at least this tall show a two-line title (content plus 4px above and below). */
	TWO_LINE_TITLE: tileContent(2) + 2 * 4,
	/** Titles longer than this are expected to wrap on a tile (so it is sized for two lines). */
	WRAP_CHARS: 36,
} as const;

/** Row gap and padding of a tile too short for the regular rhythm (the stack is crowded). */
const DENSE = { ROW_GAP: 4, MIN_PAD_Y: 3 } as const;

/**
 * How a tile of this height lays its content out: title lines, the gap between
 * rows and the padding above and below. Regular tiles keep the spacing scale;
 * a tile shorter than the regular one tightens gap and padding together so the
 * content block still sits centred with equal top and bottom padding.
 */
export function tileMetrics(tile: number): {
	lines: 1 | 2;
	gap: number;
	padY: number;
} {
	const lines = titleLines(tile);
	if (tile >= tileNeeds(1)) {
		return {
			lines,
			gap: SPACE.ROW_GAP,
			padY: Math.min(SPACE.PAD_Y, Math.floor((tile - tileContent(lines)) / 2)),
		};
	}
	const content =
		SPACE.ROW_H + DENSE.ROW_GAP + SPACE.LINE_H + DENSE.ROW_GAP + SPACE.META_H;
	return {
		lines: 1,
		gap: DENSE.ROW_GAP,
		padY: Math.max(DENSE.MIN_PAD_Y, Math.floor((tile - content) / 2)),
	};
}

/** An open lane's chrome around its tile: border, padding, and the scrollbar only while it shows. */
export function laneChrome(overflows: boolean): number {
	return LANE.BORDER + 2 * LANE.STRIP_PAD_Y + (overflows ? LANE.SCROLLBAR : 0);
}

/**
 * The tile height one lane really needs: the shared `budget` (what the stack
 * can give each open lane) capped by what its titles want, so a lane of short
 * titles is not stretched into tiles with a band above and below the content.
 * `hasMeta` says some tile has a meta line (agents, blocked reason, labels);
 * without one a one-line lane drops that row from its height.
 */
export function laneTile(
	budget: number,
	titles: readonly string[],
	hasMeta = true,
): number {
	const wraps = titles.some((t) => t.length > LANE.WRAP_CHARS);
	const wants = wraps
		? tileNeeds(2)
		: hasMeta
			? tileNeeds(1)
			: tileContent(1, false) + 2 * SPACE.PAD_Y;
	return Math.max(LANE.MIN_TILE, Math.min(budget, wants));
}

export interface LaneSizes {
	/** Height of one card tile. */
	tile: number;
	/** Height of an open lane (tile plus its chrome). */
	laneHeight: number;
	/** True when even minimum tiles do not fit: the stack scrolls vertically. */
	scrolls: boolean;
}

/**
 * Tile height from the height the lane stack has, the number of open lanes
 * with tasks, the collapsed (header-only) ones, and the open lanes with no
 * tasks (one compact row each).
 */
export function laneSizes(input: {
	available: number;
	open: number;
	collapsed: number;
	empty?: number;
}): LaneSizes {
	const { available, open, collapsed, empty = 0 } = input;
	const make = (tile: number, scrolls: boolean): LaneSizes => ({
		tile,
		laneHeight: tile + LANE.CHROME,
		scrolls,
	});
	if (!(available > 0)) return make(LANE.DEFAULT_TILE, false);
	if (open <= 0) return make(LANE.DEFAULT_TILE, false);
	const lanes = open + collapsed + empty;
	const fixed =
		LANE.STACK_PAD +
		Math.max(0, lanes - 1) * LANE.GAP +
		collapsed * LANE.COLLAPSED +
		empty * LANE.EMPTY_OPEN;
	const per = Math.floor((available - fixed) / open) - LANE.CHROME;
	if (per < LANE.MIN_TILE) return make(LANE.MIN_TILE, true);
	return make(Math.min(LANE.MAX_TILE, per), false);
}

/** How many whole tiles a lane's scroller shows at this width (the gutter is outside it). */
export function visibleTiles(scrollerWidth: number): number {
	if (!(scrollerWidth > 0)) return 0;
	return Math.max(
		0,
		Math.floor((scrollerWidth + LANE.TILE_GAP) / (LANE.TILE_W + LANE.TILE_GAP)),
	);
}

/** Two title lines when the tile is tall enough, one otherwise. */
export function titleLines(tile: number): 1 | 2 {
	return tile >= LANE.TWO_LINE_TITLE ? 2 : 1;
}

/**
 * A wheel over a lane scrolls it sideways when it can: returns the new
 * `scrollLeft`, or null to leave the event alone (a horizontal gesture the
 * browser handles itself, a lane that does not overflow, or one already at the
 * edge in that direction so the page can keep scrolling).
 */
export function wheelScrollLeft(input: {
	deltaX: number;
	deltaY: number;
	scrollLeft: number;
	scrollWidth: number;
	clientWidth: number;
}): number | null {
	const { deltaX, deltaY, scrollLeft, scrollWidth, clientWidth } = input;
	if (deltaY === 0 || Math.abs(deltaX) >= Math.abs(deltaY)) return null;
	const max = scrollWidth - clientWidth;
	if (max <= 0) return null;
	const next = Math.min(max, Math.max(0, scrollLeft + deltaY));
	return next === scrollLeft ? null : next;
}

/** The `scrollLeft` that brings `[left, left + width)` into a viewport with the least movement. */
export function scrollLeftToReveal(input: {
	scrollLeft: number;
	viewport: number;
	left: number;
	width: number;
	pad?: number;
}): number {
	const { scrollLeft, viewport, left, width, pad = 8 } = input;
	if (left - pad < scrollLeft) return Math.max(0, left - pad);
	if (left + width + pad > scrollLeft + viewport) {
		return left + width + pad - viewport;
	}
	return scrollLeft;
}

export type FocusKey =
	| "ArrowLeft"
	| "ArrowRight"
	| "ArrowUp"
	| "ArrowDown"
	| "Home"
	| "End";

export const FOCUS_KEYS: readonly string[] = [
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
	"Home",
	"End",
];

export function isFocusKey(key: string): key is FocusKey {
	return FOCUS_KEYS.includes(key);
}

/**
 * Where arrow keys move focus. `counts[i]` is the number of cards in lane `i`
 * (collapsed lanes pass 0 and are skipped). Left and right walk the lane; up
 * and down jump to the nearest lane with cards, landing on the same position
 * (clamped). Returns null when there is nowhere to go.
 */
export function stepFocus(
	counts: readonly number[],
	from: { lane: number; index: number },
	key: FocusKey,
): { lane: number; index: number } | null {
	const here = counts[from.lane] ?? 0;
	if (here === 0) return null;
	switch (key) {
		case "ArrowLeft":
			return from.index > 0 ? { lane: from.lane, index: from.index - 1 } : null;
		case "ArrowRight":
			return from.index < here - 1
				? { lane: from.lane, index: from.index + 1 }
				: null;
		case "Home":
			return from.index === 0 ? null : { lane: from.lane, index: 0 };
		case "End":
			return from.index === here - 1
				? null
				: { lane: from.lane, index: here - 1 };
		case "ArrowUp":
		case "ArrowDown": {
			const step = key === "ArrowUp" ? -1 : 1;
			for (let lane = from.lane + step; lane >= 0 && lane < counts.length; ) {
				const n = counts[lane] ?? 0;
				if (n > 0) return { lane, index: Math.min(from.index, n - 1) };
				lane += step;
			}
			return null;
		}
	}
}
