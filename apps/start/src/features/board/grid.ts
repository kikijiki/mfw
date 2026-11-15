/**
 * The grid layout's pure half, so the page and the tests read the same
 * numbers: the card spacing scale, the column template every status section
 * shares, and arrow-key focus movement across the sections' 2-D grids.
 */

/**
 * The one spacing scale of the board's cards and section headers. Everything
 * that pads, gaps or sizes a card reads these, so a grid card, a section header
 * and a Columns card keep the same rhythm.
 */
export const SPACE = {
	/** Padding above and below a card's content (and a section header's). */
	PAD_Y: 8,
	/** Padding left and right of a card's content (and a section header's). */
	PAD_X: 10,
	/** Gap between the rows inside a card. */
	ROW_GAP: 6,
	/** The first row of a card and the single row of a section header: id, icons, chevron. */
	ROW_H: 20,
	/** One line of a card's title. */
	LINE_H: 18,
} as const;

/** Pixel constants of the grid layout, shared by the inline styles and the tests. */
export const GRID = {
	/**
	 * A card is never narrower than this: the full card's first row (id, question
	 * and verdict chips, size, chevron) still fits on one line, so the grid wraps
	 * into fewer columns instead of squeezing it.
	 */
	MIN_CARD_W: 272,
	/** Gap between two cards, and between two sections. */
	GAP: 8,
	/** A collapsed (header-only) section. */
	COLLAPSED: 30,
} as const;

/**
 * As many columns as fit, each at least `MIN_CARD_W` and sharing what is left;
 * `min(100%, …)` keeps a single card inside a container narrower than the
 * minimum, so the section never scrolls sideways.
 */
export const GRID_TEMPLATE = `repeat(auto-fill, minmax(min(100%, ${GRID.MIN_CARD_W}px), 1fr))`;

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

/** One status section as focus sees it: how many cards, laid out in how many columns. */
export interface FocusSection {
	count: number;
	columns: number;
}

/**
 * Where arrow keys move focus. Cards fill each section row by row, `columns`
 * to a row (collapsed sections pass `count: 0` and are skipped). Left and
 * right walk the section in reading order; up and down move one row, and past
 * the first or last row jump to the nearest section with cards, keeping the
 * column (clamped to that row). Home and End go to the section's first and last
 * card. Returns null when there is nowhere to go.
 */
export function stepFocus(
	sections: readonly FocusSection[],
	from: { section: number; index: number },
	key: FocusKey,
): { section: number; index: number } | null {
	const here = sections[from.section];
	const count = here?.count ?? 0;
	if (count === 0) return null;
	const cols = Math.max(1, here?.columns ?? 1);
	const col = from.index % cols;
	switch (key) {
		case "ArrowLeft":
			return from.index > 0
				? { section: from.section, index: from.index - 1 }
				: null;
		case "ArrowRight":
			return from.index < count - 1
				? { section: from.section, index: from.index + 1 }
				: null;
		case "Home":
			return from.index === 0 ? null : { section: from.section, index: 0 };
		case "End":
			return from.index === count - 1
				? null
				: { section: from.section, index: count - 1 };
		case "ArrowUp":
		case "ArrowDown": {
			const step = key === "ArrowUp" ? -1 : 1;
			const within = from.index + step * cols;
			if (within >= 0 && within < count)
				return { section: from.section, index: within };
			// The last row may be short: down from above its end lands on its last card.
			if (
				step === 1 &&
				Math.floor(from.index / cols) < Math.floor((count - 1) / cols)
			)
				return { section: from.section, index: count - 1 };
			for (
				let section = from.section + step;
				section >= 0 && section < sections.length;
				section += step
			) {
				const n = sections[section]?.count ?? 0;
				if (n === 0) continue;
				const c = Math.max(1, sections[section]?.columns ?? 1);
				const rowStart = step === 1 ? 0 : Math.floor((n - 1) / c) * c;
				return {
					section,
					index: Math.min(rowStart + Math.min(col, c - 1), n - 1),
				};
			}
			return null;
		}
	}
}
