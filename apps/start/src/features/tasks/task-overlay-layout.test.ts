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

describe("task inspector layout", () => {
	const frame = read("TaskPage.tsx");
	// The two-column editor moved into the Definition tab.
	const page = read("TaskDefinition.tsx");
	const pageFrame = read("../../components/Page.tsx");

	test("keeps TaskDefinition's two-column editor at the lg breakpoint", () => {
		const columns = classTokens(page, "lg:flex-row");
		expect(columns).toContain("lg:flex-row");
		expect(classTokens(page, "lg:w-80")).toContain("lg:w-80");
	});

	test("retains the full-height flex chain and its internal scroll region", () => {
		expectClassTokens(classTokens(frame, "h-full", "min-w-0"), [
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
		expect(frame).toContain('className="shrink-0"');
	});

	test("falls back to a contained single-column layout below lg", () => {
		const columns = classTokens(page, "lg:flex-row");
		const sidebar = classTokens(page, "lg:w-80");

		expectClassTokens(columns, ["min-w-0", "flex-col", "overflow-x-hidden"]);
		expect(columns).not.toContain("flex-row");
		expectClassTokens(sidebar, ["min-w-0", "w-full"]);
	});
});
