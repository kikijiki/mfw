import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Height contract between the shell and a project screen. Screens are
 * `<Page className="h-full">` and need an ancestor with a definite height. The
 * shell's `<main>` is a block container, where `flex-1` on `ProjectLayout` does
 * nothing and `h-full` resolves against `auto`, so the whole page scrolls.
 *
 * Source-shape test (no DOM or Tailwind at test time): a project screen's height
 * must not rely on `flex-1` under a non-flex parent.
 */

const read = (rel: string) =>
	readFileSync(join(import.meta.dir, "..", "..", rel), "utf8");

/** The class list of the first element carrying `className="…"` after `marker`. */
function classesAfter(source: string, marker: string): string[] {
	const at = source.indexOf(marker);
	expect(at).toBeGreaterThan(-1);
	const match = /className=(?:"([^"]*)"|\{cn\(([\s\S]*?)\)\})/.exec(
		source.slice(at),
	);
	expect(match).not.toBeNull();
	return (match?.[1] ?? match?.[2] ?? "")
		.replace(/["'`,]/g, " ")
		.split(/\s+/)
		.filter(Boolean);
}

describe("the shell's height contract", () => {
	const shell = read("components/AppShell.tsx");
	const projectLayout = read("features/shell/ProjectLayout.tsx");

	test("<main> is a block scroll container, not a flex one", () => {
		const classes = classesAfter(shell, "<main");
		expect(classes).toContain("overflow-auto");
		// Were this `flex`, `flex-1` on the child would work.
		expect(classes).not.toContain("flex");
	});

	test("ProjectLayout claims a definite height rather than flexing", () => {
		const classes = classesAfter(projectLayout, "return (");
		expect(classes).toContain("h-full");
		expect(classes).not.toContain("flex-1");
	});
});

describe("the shell's reconnecting overlay", () => {
	const shell = read("components/AppShell.tsx");
	const errorState = read("components/ErrorState.tsx");

	test("the content region is the overlay's positioning boundary", () => {
		const classes = classesAfter(shell, "data-content-region");
		expect(classes).toContain("relative");
		expect(classes).toContain("flex-1");
		expect(classes).toContain("min-h-0");
	});

	test("reconnecting is absolutely positioned and cannot consume shell space", () => {
		const classes = classesAfter(errorState, 'role="status"');
		expect(classes).toContain("absolute");
		expect(classes).toContain("inset-x-0");
		expect(classes).toContain("top-0");
		expect(classes).toContain("z-30");
		expect(classes).toContain("pointer-events-none");
	});

	test("the reconnecting presentation uses the shared alert primitive", () => {
		expect(errorState).toContain("<Alert");
		expect(errorState).toContain("Reconnecting…");
		expect(errorState).toContain('role="status"');
	});
});

describe("mobile project navigation and controls", () => {
	const shell = read("components/AppShell.tsx");
	const projectLayout = read("features/shell/ProjectLayout.tsx");
	const dispatch = read("features/dispatch/DispatchControls.tsx");

	test("scrolls the project tabs horizontally with a visible edge affordance", () => {
		expect(projectLayout).toContain("max-md:overflow-x-auto");
		expect(projectLayout).toContain("max-md:pr-11");
		expect(projectLayout).toContain("bg-gradient-to-r");
		expect(projectLayout).toContain("max-md:min-h-11 max-md:px-3");
	});

	test("gives mobile project, global, and add actions 44px targets", () => {
		expect(dispatch).toContain('className="max-md:min-h-11 max-md:px-3"');
		expect(dispatch).toContain('className="max-md:size-11"');
		expect(shell).toContain('className="min-h-11 w-full max-w-50"');
		expect(shell).toContain(
			'size="icon-sm"\n\t\t\t\t\tclassName="max-md:size-11"\n\t\t\t\t\taria-label="Add project"',
		);
	});
});
