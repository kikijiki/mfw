import { describe, expect, test } from "bun:test";
import { missingTemplateSections, parseTaskTemplate } from "../src/template.ts";

const TEMPLATE = `# Task

## Goal

What must be true when this is done.

## Out of scope (optional)

## Documentation impact

<!-- name the pages that change, or say why none do -->

## Acceptance Criteria

- observable outcome
`;

describe("parseTaskTemplate", () => {
	test("level-2 headings are sections; (optional) marks optional ones", () => {
		const t = parseTaskTemplate(TEMPLATE);
		expect(t.sections.map((s) => [s.heading, s.required])).toEqual([
			["Goal", true],
			["Out of scope", false],
			["Documentation impact", true],
			["Acceptance Criteria", true],
		]);
		expect(t.sections[0]?.guidance).toBe(
			"What must be true when this is done.",
		);
	});

	test("headings inside code fences are not sections", () => {
		const t = parseTaskTemplate("## Real\n\n```md\n## Fake\n```\n");
		expect(t.sections.map((s) => s.heading)).toEqual(["Real"]);
	});
});

describe("missingTemplateSections", () => {
	const template = parseTaskTemplate(TEMPLATE);

	test("a complete task is missing nothing", () => {
		expect(
			missingTemplateSections(template, {
				body: "## Goal\n\nShip it.\n\n## Documentation impact\n\nNone: internal only.",
				criteriaCount: 1,
				hasVerification: false,
			}),
		).toEqual([]);
	});

	test("absent, empty, comment-only and placeholder sections are missing", () => {
		expect(
			missingTemplateSections(template, {
				body: "## goal\n\nWhat must be true when this is done.\n\n## Documentation Impact\n\n<!-- todo -->",
				criteriaCount: 0,
				hasVerification: false,
			}),
		).toEqual(["Goal", "Documentation impact", "Acceptance Criteria"]);
	});

	test("optional sections are never required", () => {
		const missing = missingTemplateSections(template, {
			body: "",
			criteriaCount: 1,
			hasVerification: false,
		});
		expect(missing).not.toContain("Out of scope");
	});

	test("verification is checked against the parsed plan, not the body", () => {
		const t = parseTaskTemplate("## Verification checks\n");
		expect(
			missingTemplateSections(t, {
				body: "",
				criteriaCount: 0,
				hasVerification: true,
			}),
		).toEqual([]);
	});
});
