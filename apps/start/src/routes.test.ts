import { describe, expect, test } from "bun:test";

import { href } from "./routes";

/**
 * Link shape. A leading `//` is a protocol-relative URL, so `//p/mfw/board`
 * would send the browser looking for a host called `p`.
 */
describe("href", () => {
	const all = [
		href.now(),
		href.inbox(),
		href.history(),
		href.resources(),
		href.runpod(),
		href.openrouter(),
		href.settings(),
		href.project("mfw"),
		href.board("mfw"),
		href.adrs("mfw"),
		href.projectInbox("mfw"),
		href.review("mfw"),
		href.task("mfw", "MFW-1"),
		href.files("mfw"),
	];

	test("every link is a single-slash absolute path", () => {
		for (const path of all) {
			expect(path.startsWith("/")).toBe(true);
			expect(path.startsWith("//")).toBe(false);
			expect(path).not.toContain("//");
		}
	});

	test("paths match the routes the router registers", () => {
		expect(href.now()).toBe("/now");
		expect(href.resources()).toBe("/resources");
		expect(href.runpod()).toBe("/runpod");
		expect(href.openrouter()).toBe("/openrouter");
		expect(href.board("mfw")).toBe("/p/mfw/board");
		expect(href.adrs("mfw", "MFW-ADR-2")).toBe("/p/mfw/adrs?adr=MFW-ADR-2");
		expect(href.task("mfw", "MFW-1")).toBe("/p/mfw/tasks/MFW-1");
	});

	test("project names and task ids are encoded, not interpolated raw", () => {
		expect(href.project("a b")).toBe("/p/a%20b");
		expect(href.task("p", "A/B")).toBe("/p/p/tasks/A%2FB");
		expect(href.adrs("p", "A/B")).toBe("/p/p/adrs?adr=A%2FB");
	});

	test("review links can preserve their inbox origin", () => {
		expect(href.reviewTask("mfw", "MFW-70", "project-inbox")).toBe(
			"/p/mfw/review/MFW-70?from=project-inbox",
		);
		expect(href.reviewTask("mfw", "MFW-70", "inbox")).toBe(
			"/p/mfw/review/MFW-70?from=inbox",
		);
	});
});
