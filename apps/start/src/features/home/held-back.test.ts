import { describe, expect, test } from "bun:test";

import { splitHeldBack } from "./needs";

describe("splitHeldBack", () => {
	test("keeps every row and orders held rows by release rank", () => {
		const { shown, held } = splitHeldBack([
			{ id: "late", heldBack: true, heldRank: 1 },
			{ id: "visible" },
			{ id: "next", heldBack: true, heldRank: 0 },
		]);
		expect(shown.map((i) => i.id)).toEqual(["visible"]);
		expect(held.map((i) => i.id)).toEqual(["next", "late"]);
	});
});
