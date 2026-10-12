import { describe, expect, test } from "bun:test";
import {
	assertAppearance,
	colorOf,
	isProjectTextMark,
	monogramOf,
	PROJECT_COLOR_KEYS,
	PROJECT_ICON_KEYS,
	resolveAvatar,
} from "../src/project-appearance.ts";

describe("project appearance", () => {
	test("every curated key is 3+ characters so it never collides with a mark", () => {
		for (const k of PROJECT_ICON_KEYS) {
			expect(k.length).toBeGreaterThanOrEqual(3);
		}
		expect(PROJECT_ICON_KEYS.length).toBeGreaterThanOrEqual(40);
		expect(PROJECT_COLOR_KEYS.length).toBe(10);
	});

	test("marks: 1-2 characters, no whitespace; an emoji the user typed is kept", () => {
		expect(isProjectTextMark("A")).toBe(true);
		expect(isProjectTextMark("k9")).toBe(true);
		expect(isProjectTextMark("🚀")).toBe(true);
		expect(isProjectTextMark("abc")).toBe(false);
		expect(isProjectTextMark("a b")).toBe(false);
		expect(isProjectTextMark("")).toBe(false);
	});

	test("assertAppearance refuses unknown values", () => {
		expect(() =>
			assertAppearance({ icon: "rocket", color: "blue" }),
		).not.toThrow();
		expect(() => assertAppearance({ icon: "nope" })).toThrow();
		expect(() => assertAppearance({ color: "chartreuse" })).toThrow();
	});

	test("defaults derive a stable monogram and colour from the name", () => {
		expect(monogramOf("dummy-todo")).toBe("DT");
		expect(monogramOf("mfw")).toBe("MF");
		expect(colorOf("mfw")).toBe(colorOf("mfw"));
		expect(resolveAvatar("dummy-todo")).toMatchObject({
			kind: "text",
			value: "DT",
			custom: false,
		});
	});

	test("stored choices win, invalid ones fall back", () => {
		expect(resolveAvatar("x", { icon: "rocket", color: "teal" })).toEqual({
			kind: "key",
			value: "rocket",
			color: "teal",
			custom: true,
		});
		expect(
			resolveAvatar("alpha", { icon: "zz9 x", color: "nope" }).custom,
		).toBe(false);
		expect(resolveAvatar("alpha", { icon: "Q" }).value).toBe("Q");
	});
});
