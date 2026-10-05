import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (file: string) =>
	readFileSync(join(import.meta.dir, file), "utf8");

function classTokens(source: string, ...identifyingTokens: string[]) {
	const classes = [...source.matchAll(/className="([^"]+)"/g)].find((match) => {
		const tokens = match[1]?.split(/\s+/) ?? [];
		return identifyingTokens.every((token) => tokens.includes(token));
	})?.[1];
	if (!classes) {
		throw new Error(`No className contains ${identifyingTokens.join(", ")}`);
	}
	return new Set(classes.split(/\s+/));
}

function expectClassTokens(tokens: Set<string>, expected: string[]) {
	for (const token of expected) expect(tokens).toContain(token);
}

describe("task overlay layout", () => {
	const overlay = read("TaskOverlay.tsx");
	const page = read("TaskPage.tsx");
	const sheet = read("../../components/ui/sheet.tsx");
	const pageFrame = read("../../components/Page.tsx");

	test("matches the desktop panel width to TaskPage's column breakpoint", () => {
		const panel = classTokens(overlay, "lg:w-[90vw]");
		const columns = classTokens(page, "lg:flex-row");

		expectClassTokens(panel, ["lg:w-[90vw]", "lg:max-w-7xl"]);
		expect(overlay).not.toContain("max-w-md");
		expect(columns).toContain("lg:flex-row");
		expect(classTokens(page, "lg:w-80")).toContain("lg:w-80");
	});

	test("retains the full-height flex chain and its internal scroll region", () => {
		expect(sheet).toContain("flex h-dvh max-w-full flex-col overflow-hidden");
		expectClassTokens(classTokens(overlay, "flex-1"), [
			"flex",
			"min-h-0",
			"flex-1",
			"flex-col",
		]);
		expectClassTokens(classTokens(page, "h-full", "min-w-0"), [
			"h-full",
			"min-w-0",
			"overflow-hidden",
		]);
		expect(pageFrame).toContain('"flex min-h-0 w-full flex-col"');
		expectClassTokens(classTokens(page, "overscroll-contain"), [
			"min-h-0",
			"flex-1",
			"overflow-x-hidden",
			"overflow-y-auto",
			"overscroll-contain",
		]);
		expect(page).toContain('className="shrink-0 pr-12"');
	});

	test("falls back to a contained single-column layout below lg", () => {
		const panel = classTokens(overlay, "lg:w-[90vw]");
		const columns = classTokens(page, "lg:flex-row");
		const sidebar = classTokens(page, "lg:w-80");

		expectClassTokens(panel, ["w-full", "max-w-none"]);
		expectClassTokens(columns, ["min-w-0", "flex-col", "overflow-x-hidden"]);
		expect(columns).not.toContain("flex-row");
		expectClassTokens(sidebar, ["min-w-0", "w-full"]);
	});
});
