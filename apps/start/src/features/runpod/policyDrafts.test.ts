import { describe, expect, test } from "bun:test";
import { listText, splitList, toggleChoice } from "./policyDrafts";

describe("RunPod project choice helpers", () => {
	test("normalizes only real selectable values", () => {
		expect(splitList("a, b\na\n c ")).toEqual(["a", "b", "c"]);
		expect(listText(undefined)).toBe("");
		expect(listText(["one", "two"])).toBe("one\ntwo");
		expect(toggleChoice(["SECURE"], "COMMUNITY")).toEqual([
			"SECURE",
			"COMMUNITY",
		]);
		expect(toggleChoice(["SECURE", "COMMUNITY"], "SECURE")).toEqual([
			"COMMUNITY",
		]);
	});
});
