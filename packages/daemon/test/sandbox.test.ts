import { describe, expect, test } from "bun:test";
import { bwrapAvailable } from "../src/sandbox.ts";

describe("bwrapAvailable", () => {
	test("is a stable boolean across repeated calls (cached)", async () => {
		const a = await bwrapAvailable();
		const b = await bwrapAvailable();
		expect(a).toBe(b);
		expect(typeof a).toBe("boolean");
	});
});
