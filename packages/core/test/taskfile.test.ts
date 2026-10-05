import { describe, expect, test } from "bun:test";
import {
	parseTaskFile,
	renderTaskFile,
	type TaskFile,
} from "../src/taskfile.ts";

/** Draft workflow state lives in the containing directory. The task file keeps
 * only the captured prompt and its post-expansion destination. */

function baseFrontmatter(over: Partial<TaskFile["frontmatter"]> = {}) {
	return {
		id: "MFW-1",
		rev: 1,
		title: "a task",
		type: "implementation" as const,
		priority: "medium" as const,
		size: null,
		labels: [],
		parent: null,
		depends_on: [],
		spike_timebox: null,
		requires_resources: [],
		execution_target: "local",
		local_staging_resources: [],
		workload_secret_grants: [],
		require_review: false,
		created: null,
		source: "human" as const,
		split_from: null,
		lifetime_def: null,
		blocked_reason: null,
		draft_prompt: null,
		after_expansion: "ready" as const,
		ready_mode: "automatic" as const,
		owns: [],
		model_tier: null,
		discovered_from: null,
		reopen_when: [],
		...over,
	};
}

describe("taskfile: draft capture metadata", () => {
	test("capture metadata is quiet by default", () => {
		const content = renderTaskFile({
			frontmatter: baseFrontmatter(),
			body: "body text",
			criteria: [],
			dod: null,
		});
		expect(content).not.toContain("draft_prompt");
		expect(content).not.toContain("after_expansion");
	});

	test("the captured prompt round-trips without duplicating workflow state", () => {
		const file: TaskFile & { frontmatter: { id: string; rev: number } } = {
			frontmatter: baseFrontmatter({
				draft_prompt: "call the plumber\nabout the leak",
			}),
			body: "call the plumber\nabout the leak",
			criteria: [],
			dod: null,
		};
		const content = renderTaskFile(file);
		expect(content).not.toContain("draft: true");

		const parsed = parseTaskFile(content);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.file.frontmatter.draft_prompt).toBe(
			"call the plumber\nabout the leak",
		);
	});

	test("draft_prompt is durable after expansion", () => {
		const file = {
			frontmatter: baseFrontmatter({
				draft_prompt: "the original one-liner",
			}),
			body: "an expanded body",
			criteria: [],
			dod: null,
		};
		const content = renderTaskFile(file);
		expect(content).not.toContain("draft: true");
		expect(content).toContain("draft_prompt: the original one-liner");

		const parsed = parseTaskFile(content);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.file.frontmatter.draft_prompt).toBe("the original one-liner");
	});

	test("a file with no capture metadata parses with safe defaults", () => {
		const raw = [
			"---",
			'title: "hand-written task"',
			"type: implementation",
			"priority: medium",
			"---",
			"",
			"just some prose",
			"",
		].join("\n");
		const parsed = parseTaskFile(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.file.frontmatter.draft_prompt).toBeNull();
		expect(parsed.file.frontmatter.after_expansion).toBe("ready");
	});

	test("an explicit post-expansion backlog destination round-trips", () => {
		const content = renderTaskFile({
			frontmatter: baseFrontmatter({
				after_expansion: "backlog",
			}),
			body: "captured intent",
			criteria: [],
			dod: null,
		});
		expect(content).toContain("after_expansion: backlog");
		const parsed = parseTaskFile(content);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.file.frontmatter.after_expansion).toBe("backlog");
	});
});

describe("taskfile: acceptance and verification migration", () => {
	test("canonical writes use acceptance bullets and a verification fence", () => {
		const content = renderTaskFile({
			frontmatter: baseFrontmatter(),
			body: "Implement the behavior.",
			criteria: [{ text: "The behavior is observable", checked: true }],
			dod: {
				verifier: "deterministic",
				checks: [{ run: "bun test", expect_exit: 0 }],
			},
		});
		expect(content).toContain(
			"## Acceptance Criteria\n\n- The behavior is observable",
		);
		expect(content).toContain("## Verification checks\n\n```verification");
		expect(content).not.toContain("```dod");
		expect(content).not.toContain("[x]");
	});

	test("legacy checkbox criteria and dod fences remain readable", () => {
		const raw = [
			"---",
			'title: "legacy task"',
			"type: implementation",
			"priority: medium",
			"---",
			"",
			"Legacy body.",
			"",
			"## Acceptance Criteria",
			"",
			"- [x] shipped behavior",
			"- [ ] covered edge case",
			"",
			"## Definition of Done",
			"",
			"```dod",
			"verifier: deterministic",
			"checks:",
			"  - run: bun test",
			"    expect_exit: 0",
			"```",
			"",
		].join("\n");
		const parsed = parseTaskFile(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.file.criteria).toEqual([
			{ text: "shipped behavior", checked: true },
			{ text: "covered edge case", checked: false },
		]);
		expect(parsed.file.dod?.checks).toEqual([
			{ run: "bun test", expect_exit: 0 },
		]);
	});

	test("capture ids survive canonical round trips", () => {
		const content = renderTaskFile({
			frontmatter: baseFrontmatter({ capture_id: "phone-request-1" }),
			body: "captured text",
			criteria: [],
			dod: null,
		});
		const parsed = parseTaskFile(content);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.file.frontmatter.capture_id).toBe("phone-request-1");
	});
});

describe("taskfile: scoped resource requirements", () => {
	test("structured host/project resources and remote staging round-trip", () => {
		const content = renderTaskFile({
			frontmatter: baseFrontmatter({
				requires_resources: [
					"serial-tests",
					{ scope: "project", id: "database", amount: 1 },
					{ scope: "host", id: "gpu", amount: 1 },
				],
				execution_target: "remote-test",
				local_staging_resources: [{ scope: "host", id: "disk-io", amount: 1 }],
				workload_secret_grants: ["provider-for-this-task"],
			}),
			body: "remote task",
			criteria: [],
			dod: null,
		});
		const parsed = parseTaskFile(content);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.file.frontmatter.requires_resources).toEqual([
			"serial-tests",
			{ scope: "project", id: "database", amount: 1 },
			{ scope: "host", id: "gpu", amount: 1 },
		]);
		expect(parsed.file.frontmatter.execution_target).toBe("remote-test");
		expect(parsed.file.frontmatter.local_staging_resources).toEqual([
			{ scope: "host", id: "disk-io", amount: 1 },
		]);
		expect(parsed.file.frontmatter.workload_secret_grants).toEqual([
			"provider-for-this-task",
		]);
	});

	test("strict structured amounts accept integer counts and explicit IEC bytes", () => {
		const raw = [
			"---",
			"id: MFW-quantity-test",
			"rev: 1",
			"title: quantities",
			"type: implementation",
			"priority: medium",
			"requires_resources:",
			"  - { scope: host, id: cpu, amount: 4 }",
			"  - { scope: host, id: ram, amount: 8 GiB }",
			"  - { scope: host, id: gpu }",
			"---",
			"body",
		].join("\n");
		const parsed = parseTaskFile(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.file.frontmatter.requires_resources).toEqual([
			{ scope: "host", id: "cpu", amount: 4 },
			{ scope: "host", id: "ram", amount: "8 GiB" },
			{ scope: "host", id: "gpu" },
		]);
		expect(
			parseTaskFile(
				renderTaskFile(
					parsed.file as TaskFile & {
						frontmatter: { id: string; rev: number };
					},
				),
			),
		).toEqual(parsed);
	});

	for (const [label, line] of [
		["fractional", "{ scope: host, id: cpu, amount: 1.5 }"],
		["zero", "{ scope: host, id: cpu, amount: 0 }"],
		["negative", "{ scope: host, id: cpu, amount: -1 }"],
		["ambiguous unitless string", "{ scope: host, id: ram, amount: '8' }"],
		["SI unit", "{ scope: host, id: ram, amount: 8 GB }"],
		["fractional bytes", "{ scope: host, id: ram, amount: 1.5 GiB }"],
		["overflowing bytes", "{ scope: host, id: ram, amount: 8 EiB }"],
		["project quantity", "{ scope: project, id: serial, amount: 2 }"],
		["implicit unit field", "{ scope: host, id: ram, amount: 8, unit: GiB }"],
	] as const) {
		test(`rejects ${label} resource authoring`, () => {
			const parsed = parseTaskFile(
				[
					"---",
					"title: invalid quantity",
					"type: implementation",
					"priority: medium",
					"requires_resources:",
					`  - ${line}`,
					"---",
				].join("\n"),
			);
			expect(parsed.ok).toBe(false);
			if (parsed.ok) return;
			expect(parsed.reason).toContain("requires_resources");
		});
	}

	for (const [caseName, field, entries] of [
		[
			"bare and structured project requirements",
			"requires_resources",
			["serial", "{ scope: project, id: serial }"],
		],
		[
			"structured host requirements",
			"requires_resources",
			[
				"{ scope: host, id: ram, amount: 1 GiB }",
				"{ scope: host, id: ram, amount: 2 GiB }",
			],
		],
		[
			"local staging requirements",
			"local_staging_resources",
			[
				"{ scope: host, id: disk, amount: 1 }",
				"{ scope: host, id: disk, amount: 2 }",
			],
		],
	] as const) {
		test(`rejects duplicate scoped ids in ${caseName}`, () => {
			const parsed = parseTaskFile(
				[
					"---",
					"title: duplicate resource",
					"type: implementation",
					"priority: medium",
					`${field}:`,
					...entries.map((entry) => `  - ${entry}`),
					"---",
				].join("\n"),
			);
			expect(parsed.ok).toBe(false);
			if (parsed.ok) return;
			expect(parsed.reason).toContain("duplicate");
		});
	}
});

describe("taskfile: ownership, model tier, follow-up lineage, reopen conditions", () => {
	const header = [
		"---",
		"title: scoped",
		"type: implementation",
		"priority: medium",
	];

	test("the new fields are quiet by default", () => {
		const content = renderTaskFile({
			frontmatter: baseFrontmatter(),
			body: "",
			criteria: [],
			dod: null,
		});
		for (const key of [
			"owns",
			"model_tier",
			"discovered_from",
			"reopen_when",
		]) {
			expect(content).not.toContain(`${key}:`);
		}
	});

	test("they parse, normalize and round-trip", () => {
		const parsed = parseTaskFile(
			[
				...header,
				"owns: [./src/api/, src/api, 'docs/**/*.md']",
				"model_tier: strong",
				"discovered_from: MFW-3",
				"reopen_when:",
				"  - task_done: MFW-2",
				"  - run: test -f ready.flag",
				"    timeout: 30",
				"---",
			].join("\n"),
		);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const fm = parsed.file.frontmatter;
		expect(fm.owns).toEqual(["src/api", "docs/**/*.md"]);
		expect(fm.model_tier).toBe("strong");
		expect(fm.discovered_from).toBe("MFW-3");
		expect(fm.reopen_when).toEqual([
			{ task_done: "MFW-2" },
			{ run: "test -f ready.flag", expect_exit: 0, timeout: 30 },
		]);
		const rendered = renderTaskFile({
			...parsed.file,
			frontmatter: { ...fm, id: "MFW-9", rev: 1 },
		});
		const again = parseTaskFile(rendered);
		expect(again.ok && again.file.frontmatter).toEqual({
			...fm,
			id: "MFW-9",
			rev: 1,
		});
	});

	test("an owns pattern that escapes the repository is rejected", () => {
		const parsed = parseTaskFile(
			[...header, "owns: [../elsewhere]", "---"].join("\n"),
		);
		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.reason).toContain("owns '../elsewhere'");
	});

	test("an unknown model tier and a malformed condition are rejected", () => {
		expect(
			parseTaskFile([...header, "model_tier: huge", "---"].join("\n")).ok,
		).toBe(false);
		expect(
			parseTaskFile(
				[...header, "reopen_when: [{ after: tomorrow }]", "---"].join("\n"),
			).ok,
		).toBe(false);
	});
});
