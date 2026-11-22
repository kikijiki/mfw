import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lensActive, projectNav } from "./projectNav";

describe("project header navigation", () => {
	const nav = projectNav("mfw", { triggersNeedingAttention: 2 });

	test("Lead first, then two lenses over the same work: Board and Flow", () => {
		expect(nav.lenses.map((l) => l.label)).toEqual(["Lead", "Board", "Flow"]);
		const [lead, board, flow] = nav.lenses;
		expect(lead?.to).toBe("/p/mfw");
		expect(lead?.exact).toBe(true);
		expect(board?.disabled).toBeUndefined();
		expect(board?.to).toBe("/p/mfw/board");
		expect(flow?.disabled).toBeUndefined();
		expect(flow?.to).toBe("/p/mfw/flow");
	});

	test("Lead is active only on its own path, never on another tab's", () => {
		const [lead, board] = nav.lenses;
		const active = (p: string, to: string) =>
			p === to || p.startsWith(`${to}/`);
		for (const path of ["/p/mfw", "/p/mfw/"]) {
			expect(lead && lensActive(path, lead, active)).toBe(true);
		}
		expect(lead && lensActive("/p/mfw/board", lead, active)).toBe(false);
		expect(lead && lensActive("/p/mfw/runs/r1", lead, active)).toBe(false);
		expect(board && lensActive("/p/mfw/board", board, active)).toBe(true);
	});

	test("everything that is not a lens is in the overflow", () => {
		expect(nav.overflow.map((e) => e.label)).toEqual([
			"Docs",
			"Triggers",
			"Repo",
			"Settings",
		]);
		expect(nav.overflow.find((e) => e.label === "Repo")?.to).toBe(
			"/p/mfw/repo",
		);
		expect(nav.overflow.find((e) => e.label === "Triggers")?.badge).toBe(2);
		expect(
			projectNav("mfw", { triggersNeedingAttention: 0 }).overflow.find(
				(e) => e.label === "Triggers",
			)?.badge,
		).toBeUndefined();
	});

	test("Review, Inbox and Agents are not destinations", () => {
		const all = [...nav.lenses, ...nav.overflow].map((e) => e.label);
		for (const gone of ["Review", "Inbox", "Agents"]) {
			expect(all).not.toContain(gone);
		}
	});
});

describe("the shell's nav arrays", () => {
	const shell = readFileSync(
		join(import.meta.dir, "..", "..", "components", "AppShell.tsx"),
		"utf8",
	);

	test("Home replaces Now, Inbox, History and Agents", () => {
		expect(shell).toContain('{ label: "Home", to: href.home()');
		for (const label of ["Now", "Inbox", "History", "Agents"]) {
			expect(shell).not.toContain(`label: "${label}"`);
		}
	});

	test("the dock is not mounted; the presence bar is", () => {
		expect(shell).not.toContain(`Agent${"Dock"}`);
		expect(shell).toContain("<PresenceBar");
	});
});
