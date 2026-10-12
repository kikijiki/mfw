import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { StatusIcon, TaskTypeIcon } from "./index";
import {
	hashName,
	STATUS_ROLE_LOOK,
	statusLook,
	TASK_TYPE_LOOK,
	taskTypeLook,
} from "./looks";

const ROLES = [
	"draft",
	"backlog",
	"ready",
	"in_progress",
	"blocked",
	"review",
	"done",
	"archived",
];

describe("status icons", () => {
	test("every canonical role has its own icon and its own label", () => {
		const looks = ROLES.map((r) => statusLook(r));
		expect(new Set(looks.map((l) => l.icon)).size).toBe(ROLES.length);
		expect(new Set(looks.map((l) => l.label)).size).toBe(ROLES.length);
		for (const l of looks) expect(l.token.startsWith("--mfw-")).toBe(true);
	});

	test("the icon follows the ROLE, not the board's own value", () => {
		expect(statusLook("in_progress", "doing").icon).toBe(
			STATUS_ROLE_LOOK.in_progress?.icon as never,
		);
		expect(statusLook("done", "shipped").icon).toBe(
			STATUS_ROLE_LOOK.done?.icon as never,
		);
	});

	test("a role-less status reads by obvious name, else a deterministic fallback", () => {
		expect(statusLook(null, "failed").label).toBe("failed");
		expect(statusLook(null, "Cancelled").label).toBe("cancelled");
		const a = statusLook(null, "icebox");
		const b = statusLook(null, "icebox");
		expect(a.icon).toBe(b.icon);
		expect(a.token).toBe(b.token);
		expect(a.label).toBe("icebox");
		expect(statusLook(null).label).toBe("status");
	});

	test("StatusIcon carries an accessible label, the board's wording wins", () => {
		const html = renderToStaticMarkup(
			<StatusIcon statusRole="in_progress" value="doing" label="Doing" />,
		);
		expect(html).toContain('aria-label="Doing"');
		expect(html).toContain("var(--mfw-status-in-progress)");
		const bare = renderToStaticMarkup(<StatusIcon statusRole="review" />);
		expect(bare).toContain('aria-label="in review"');
		const withText = renderToStaticMarkup(
			<StatusIcon statusRole="done" showLabel />,
		);
		expect(withText).toContain(">done</span>");
	});
});

describe("task type icons", () => {
	const TYPES = Object.keys(TASK_TYPE_LOOK);

	test("common types are distinct icons with distinct labels", () => {
		for (const t of ["epic", "feature", "bug", "chore", "spike", "docs"]) {
			expect(TYPES).toContain(t);
		}
		const looks = TYPES.map((t) => taskTypeLook(t));
		expect(new Set(looks.map((l) => l.icon)).size).toBe(TYPES.length);
		expect(new Set(looks.map((l) => l.label)).size).toBe(TYPES.length);
	});

	test("aliases read as their type; matching ignores case and separators", () => {
		expect(taskTypeLook("Bugfix").icon).toBe(TASK_TYPE_LOOK.bug?.icon as never);
		expect(taskTypeLook("DOCS").label).toBe("docs");
	});

	test("an unknown type gets the same fallback every time, and it has a label", () => {
		const a = taskTypeLook("data-migration");
		const b = taskTypeLook("data-migration");
		expect(a).toEqual(b);
		expect(a.label).toBe("data migration");
		expect(hashName("x")).toBe(hashName("x"));
		const variants = new Set(
			["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map(
				(n) => taskTypeLook(n).token,
			),
		);
		expect(variants.size).toBeGreaterThan(1);
	});

	test("TaskTypeIcon renders a label for assistive tech", () => {
		expect(renderToStaticMarkup(<TaskTypeIcon type="bug" />)).toContain(
			'aria-label="bug"',
		);
		expect(
			renderToStaticMarkup(<TaskTypeIcon type="spike" showLabel />),
		).toContain(">spike</span>");
		expect(renderToStaticMarkup(<TaskTypeIcon type={null} />)).toContain(
			'aria-label="no type"',
		);
	});
});
