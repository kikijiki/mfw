import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { parseNodeRef } from "../../lib/nodeRef";
import {
	closeNodeSearch,
	DOCK_BREAKPOINTS,
	type DockSide,
	dockFor,
	dockLayout,
	inspectorBindings,
} from "./dock";
import {
	INSPECTOR_TABS,
	InspectorDockLayout,
	InspectorFrame,
	resolveTab,
} from "./Inspector";

describe("dock side follows the breakpoints (design §11.4)", () => {
	test("phone, tablet, desktop, wide", () => {
		expect(dockFor(375)).toBe("full");
		expect(dockFor(767)).toBe("full");
		expect(dockFor(768)).toBe("bottom");
		expect(dockFor(1279)).toBe("bottom");
		expect(dockFor(1280)).toBe("right");
		expect(dockFor(1679)).toBe("right");
		expect(dockFor(1680)).toBe("split");
		expect(dockFor(2560)).toBe("split");
	});

	test("the breakpoint table is the one the helper reads", () => {
		expect(DOCK_BREAKPOINTS).toEqual({ bottom: 768, right: 1280, split: 1680 });
	});
});

describe("dockLayout renders per breakpoint", () => {
	const render = (side: DockSide) =>
		renderToStaticMarkup(
			<InspectorDockLayout side={side} inspector={<i>insp</i>}>
				<b>lens</b>
			</InspectorDockLayout>,
		);

	test("right and split sit beside the lens, in the flow", () => {
		for (const side of ["right", "split"] as const) {
			const html = render(side);
			expect(html).toContain("flex-row");
			expect(html).toContain("border-l");
			expect(html).not.toContain("fixed");
			expect(html).toContain(`data-dock="${side}"`);
		}
	});

	test("bottom stacks under the lens, in the flow", () => {
		const html = render("bottom");
		expect(html).toContain("flex-col");
		expect(html).toContain("border-t");
		expect(html).not.toContain("fixed");
	});

	test("full covers the screen", () => {
		const html = render("full");
		expect(html).toContain("fixed inset-0");
	});

	test("lens first, inspector second, and no inspector means no pane", () => {
		const open = render("right");
		expect(open.indexOf("lens")).toBeLessThan(open.indexOf("insp"));
		const closed = renderToStaticMarkup(
			<InspectorDockLayout side="right" inspector={null}>
				<b>lens</b>
			</InspectorDockLayout>,
		);
		expect(closed).not.toContain("<aside");
		expect(closed).toContain('data-dock="none"');
	});

	test("every side has container and pane classes", () => {
		for (const side of ["full", "bottom", "right", "split"] as const) {
			const l = dockLayout(side);
			expect(l.container.length).toBeGreaterThan(0);
			expect(l.pane.length).toBeGreaterThan(0);
		}
	});
});

describe("closing", () => {
	test("Escape closes a docked inspector and removes the node param", () => {
		let closed = 0;
		const [binding] = inspectorBindings({
			presentation: "dock",
			onClose: () => {
				closed++;
			},
		});
		expect(binding?.key).toBe("Escape");
		expect(binding?.enabled).toBe(true);
		binding?.run(new Event("keydown") as KeyboardEvent);
		expect(closed).toBe(1);

		expect(
			closeNodeSearch({ node: "task:A-1", tab: "story", q: "x", t: "2026" }),
		).toEqual({ q: "x", t: "2026" });
	});

	test("the sheet and the page leave Escape to their own chrome", () => {
		for (const presentation of ["sheet", "page"] as const) {
			const [binding] = inspectorBindings({ presentation, onClose: () => {} });
			expect(binding?.enabled).toBe(false);
		}
	});

	test("Escape is not a single-key shortcut that fires inside a text field", () => {
		const [binding] = inspectorBindings({
			presentation: "dock",
			onClose: () => {},
		});
		// The registry swallows non-modifier keys in inputs unless a binding opts in.
		expect(binding?.allowInInput).toBeFalsy();
	});
});

describe("frame", () => {
	const frame = (ref: string, presentation: "dock" | "sheet" | "page") => {
		const parsed = parseNodeRef(ref);
		if (!parsed) throw new Error(ref);
		return renderToStaticMarkup(
			<InspectorFrame
				parsed={parsed}
				presentation={presentation}
				tab={resolveTab(parsed.kind)}
			>
				<p>body</p>
			</InspectorFrame>,
		);
	};

	test("header names the kind and the id, and the body renders", () => {
		const html = frame("task:MFW-41", "dock");
		expect(html).toContain("Task");
		expect(html).toContain("MFW-41");
		expect(html).toContain("<p>body</p>");
		expect(html).toContain('aria-label="Task inspector"');
		expect(html).toContain('data-presentation="dock"');
	});

	test("the same frame renders as a page and as a sheet", () => {
		expect(frame("run:01J", "page")).toContain('data-presentation="page"');
		expect(frame("run:01J", "sheet")).toContain("pr-12");
	});

	test("the brain has no id to show", () => {
		expect(frame("brain", "dock")).toContain("Brain");
	});

	test("resolveTab falls back to the kind's first tab", () => {
		expect(resolveTab("task")).toBe("story");
		expect(resolveTab("task", "nope")).toBe("story");
		expect(resolveTab("task", "definition")).toBe("definition");
		expect(resolveTab("task", "changes")).toBe("changes");
		expect(resolveTab("run", "transcript")).toBe("transcript");
		expect(resolveTab("task", "changes")).toBe("changes");
		expect(resolveTab("brain")).toBe("decisions");
		expect(resolveTab("brain", "plan")).toBe("plan");
		expect(resolveTab("turn")).toBe("transcript");
		expect(resolveTab("group")).toBeNull();
		expect(Object.keys(INSPECTOR_TABS).length).toBe(8);
	});
});

describe("wiring", () => {
	const read = (file: string) =>
		readFileSync(join(import.meta.dir, file), "utf8");

	test("the task route is the Inspector (docked redirect, or a page), not TaskPage or a sheet", () => {
		const route = read("../tasks/TaskRoutePage.tsx");
		expect(route).toContain("<Inspector");
		expect(route).toContain('presentation="page"');
		expect(route).not.toContain("<TaskPage");
		expect(route).not.toContain("Sheet");
	});

	test("the board route and the full-page route both mount the Inspector", () => {
		const board = read("../../routes/p.$project.board.tsx");
		const page = read("../../routes/p.$project.n.$ref.tsx");
		expect(board).toContain("<Inspector");
		expect(board).toContain('presentation="dock"');
		expect(page).toContain("<Inspector");
		expect(page).toContain('presentation="page"');
		expect(page).toContain('createFileRoute("/p/$project/n/$ref")');
	});
});

describe("the Changes tab (review is a tab, not a page)", () => {
	const read = (file: string) =>
		readFileSync(join(import.meta.dir, file), "utf8");

	test("a task has Story, Definition and Changes, in that order", () => {
		expect(INSPECTOR_TABS.task.map((t) => t.id)).toEqual([
			"story",
			"definition",
			"changes",
		]);
	});

	test("the tab mounts ReviewPage, so approve and reject live there", () => {
		const page = read("../tasks/TaskPage.tsx");
		expect(page).toContain("<ReviewPage");
		expect(page).toContain('"changes"');
	});

	test("ReviewPage navigates through props only", () => {
		const review = read("../review/ReviewPage.tsx");
		expect(review).toContain("onOpenTask");
		expect(review).toContain("onDecided");
		// It no longer builds a review URL of its own (the queue walk is a prop).
		expect(review).not.toContain("href.reviewTask");
	});
});

describe("scrubbed (read-only)", () => {
	const render = (
		scrub: { at: number; now: number; onLive: () => void } | null,
	) => {
		const parsed = parseNodeRef("task:A-1");
		if (!parsed) throw new Error("ref");
		return renderToStaticMarkup(
			<InspectorFrame
				parsed={parsed}
				presentation="dock"
				tab="story"
				scrub={scrub}
			>
				<button type="button">Approve</button>
			</InspectorFrame>,
		);
	};

	test("a banner and a disabled body while t is set", () => {
		const now = Date.UTC(2026, 9, 12, 12, 0, 0);
		const html = render({ at: now - 38 * 60_000, now, onLive: () => {} });
		expect(html).toContain("data-scrub-banner");
		expect(html).toContain("Back to live (L)");
		// Controls inside the body are disabled by the fieldset.
		expect(html).toMatch(/<fieldset[^>]*disabled[^>]*>.*Approve/s);
	});

	test("nothing changes while live", () => {
		const html = render(null);
		expect(html).not.toContain("data-scrub-banner");
		expect(html).not.toContain("<fieldset");
	});
});
