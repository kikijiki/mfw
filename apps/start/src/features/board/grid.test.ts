import { describe, expect, test } from "bun:test";
import { GRID, GRID_TEMPLATE, isFocusKey, stepFocus } from "./grid";

describe("the grid template", () => {
	test("fills as many columns as fit, never narrower than a card, never wider than the section", () => {
		expect(GRID_TEMPLATE).toContain("auto-fill");
		expect(GRID_TEMPLATE).toContain(`min(100%, ${GRID.MIN_CARD_W}px)`);
		expect(GRID_TEMPLATE).toContain("1fr");
	});
});

describe("stepFocus", () => {
	// Section 0: 5 cards in 3 columns (rows [0 1 2] [3 4]); 1 collapsed; 2: 2 cards in 3; 3: 7 cards in 2.
	const sections = [
		{ count: 5, columns: 3 },
		{ count: 0, columns: 3 },
		{ count: 2, columns: 3 },
		{ count: 7, columns: 2 },
	];
	const at = (section: number, index: number) => ({ section, index });

	test("left and right walk the section in reading order and stop at its ends", () => {
		expect(stepFocus(sections, at(0, 2), "ArrowRight")).toEqual(at(0, 3));
		expect(stepFocus(sections, at(0, 3), "ArrowLeft")).toEqual(at(0, 2));
		expect(stepFocus(sections, at(0, 4), "ArrowRight")).toBeNull();
		expect(stepFocus(sections, at(0, 0), "ArrowLeft")).toBeNull();
	});

	test("home and end go to the section's first and last card", () => {
		expect(stepFocus(sections, at(0, 2), "Home")).toEqual(at(0, 0));
		expect(stepFocus(sections, at(0, 2), "End")).toEqual(at(0, 4));
		expect(stepFocus(sections, at(0, 0), "Home")).toBeNull();
		expect(stepFocus(sections, at(0, 4), "End")).toBeNull();
	});

	test("up and down move one row inside a section", () => {
		expect(stepFocus(sections, at(0, 1), "ArrowDown")).toEqual(at(0, 4));
		expect(stepFocus(sections, at(0, 4), "ArrowUp")).toEqual(at(0, 1));
		expect(stepFocus(sections, at(3, 2), "ArrowDown")).toEqual(at(3, 4));
	});

	test("down into a short last row lands on its last card", () => {
		expect(stepFocus(sections, at(0, 2), "ArrowDown")).toEqual(at(0, 4));
	});

	test("past the edge row, up and down skip collapsed sections and keep the column", () => {
		// last row of section 0, column 1 -> first row of section 2, column 1
		expect(stepFocus(sections, at(0, 4), "ArrowDown")).toEqual(at(2, 1));
		expect(stepFocus(sections, at(0, 3), "ArrowDown")).toEqual(at(2, 0));
		// up from section 3's first row lands in section 2's last row
		expect(stepFocus(sections, at(3, 1), "ArrowUp")).toEqual(at(2, 1));
		// up from section 2 lands in section 0's last (short) row
		expect(stepFocus(sections, at(2, 1), "ArrowUp")).toEqual(at(0, 4));
		// different widths: column 1 of a 3-wide row into a 2-wide grid
		expect(stepFocus(sections, at(2, 1), "ArrowDown")).toEqual(at(3, 1));
	});

	test("a column the next section does not have is clamped to its row", () => {
		const uneven = [
			{ count: 3, columns: 3 },
			{ count: 2, columns: 2 },
		];
		expect(stepFocus(uneven, at(0, 2), "ArrowDown")).toEqual(at(1, 1));
		expect(
			stepFocus(
				[
					{ count: 3, columns: 3 },
					{ count: 1, columns: 3 },
				],
				at(0, 2),
				"ArrowDown",
			),
		).toEqual(at(1, 0));
	});

	test("nowhere to go above the first section or below the last", () => {
		expect(stepFocus(sections, at(0, 0), "ArrowUp")).toBeNull();
		expect(stepFocus(sections, at(3, 6), "ArrowDown")).toBeNull();
		expect(stepFocus(sections, at(1, 0), "ArrowDown")).toBeNull();
	});

	test("a one-column grid behaves like a list", () => {
		const list = [{ count: 3, columns: 1 }];
		expect(stepFocus(list, at(0, 0), "ArrowDown")).toEqual(at(0, 1));
		expect(stepFocus(list, at(0, 2), "ArrowUp")).toEqual(at(0, 1));
	});

	test("only arrows, Home and End are focus keys", () => {
		expect(isFocusKey("ArrowUp")).toBe(true);
		expect(isFocusKey("End")).toBe(true);
		expect(isFocusKey(" ")).toBe(false);
		expect(isFocusKey("Enter")).toBe(false);
	});
});
