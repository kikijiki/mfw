import { describe, expect, test } from "bun:test";
import { ACT_TOOLS, type ActTool } from "../src/brain-runtime/actions.ts";
import {
	ACTION_CLASSES,
	type ActionClass,
	classifyAction,
	DEFAULT_RIGHTS,
	decide,
	isHostExecutedPath,
	isTainting,
	PROVENANCES,
	type Right,
	type RightsFacts,
} from "../src/brain-runtime/decision-rights.ts";

const facts = (over: Partial<RightsFacts> = {}): RightsFacts => ({
	ownerAuthored: () => false,
	knownCommands: new Set(),
	changedFiles: [],
	...over,
});

/** The owner's defaults, spelled out independently of the table under test. */
const EXPECTED: Record<ActionClass, { clean: Right; tainted: Right }> = {
	own_memory: { clean: "autonomous", tainted: "autonomous" },
	escalate: { clean: "autonomous", tainted: "autonomous" },
	run_control: { clean: "notify_after", tainted: "notify_after" },
	dispatch: { clean: "notify_after", tainted: "notify_after" },
	board_edit: { clean: "notify_after", tainted: "notify_after" },
	merge_select: { clean: "notify_after", tainted: "notify_after" },
	goal_scope: { clean: "notify_after", tainted: "ask_first" },
	verification_change: { clean: "notify_after", tainted: "ask_first" },
	budget_lower: { clean: "notify_after", tainted: "ask_first" },
	nonproduction_deploy: { clean: "notify_after", tainted: "ask_first" },
	adr_proposal: { clean: "notify_after", tainted: "ask_first" },
	budget_ceiling: { clean: "ask_first", tainted: "ask_first" },
	sandbox_widening: { clean: "ask_first", tainted: "ask_first" },
	arm_trigger: { clean: "ask_first", tainted: "ask_first" },
	production_deploy: { clean: "ask_first", tainted: "ask_first" },
	adr_acceptance: { clean: "ask_first", tainted: "ask_first" },
	host_executed_merge: { clean: "ask_first", tainted: "ask_first" },
	publish_outward: { clean: "ask_first", tainted: "ask_first" },
};

describe("the matrix: action class x provenance x decision", () => {
	for (const cls of ACTION_CLASSES) {
		for (const p of PROVENANCES) {
			test(`${cls} from ${p}`, () => {
				const want = isTainting(p)
					? EXPECTED[cls].tainted
					: EXPECTED[cls].clean;
				const got = decide([cls], ["host", p]);
				expect(got.right).toBe(want);
				expect(got.cause).toBe(
					want === "ask_first" && EXPECTED[cls].clean !== "ask_first"
						? "taint"
						: "default",
				);
			});
		}
	}

	test("only agent and external text taints", () => {
		expect(PROVENANCES.filter(isTainting)).toEqual(["agent", "external"]);
	});

	test("owner text in the same turn does not clear the taint", () => {
		expect(decide(["goal_scope"], ["owner", "external"]).right).toBe(
			"ask_first",
		);
	});

	test("no provenance record reads as untrusted", () => {
		const d = decide(["goal_scope"], []);
		expect(d.right).toBe("ask_first");
		expect(d.tainted).toBe(true);
	});

	test("no class reads as the strictest", () => {
		expect(decide([], ["owner"]).right).toBe("ask_first");
	});

	test("the strictest class of a call decides", () => {
		const d = decide(["board_edit", "verification_change"], ["agent"]);
		expect(d.right).toBe("ask_first");
		expect(d.actionClass).toBe("verification_change");
	});

	test("every class has a table entry", () => {
		expect(Object.keys(DEFAULT_RIGHTS).sort()).toEqual(
			[...ACTION_CLASSES].sort(),
		);
	});
});

describe("classifyAction", () => {
	const minimal: Record<ActTool, Record<string, unknown>> = {
		create_tasks: { tasks: [{ title: "t" }] },
		update_task: { id: "T", patch: { priority: "low" } },
		reparent: { id: "T", parent: null },
		split_task: { id: "T", into: [{ title: "a" }, { title: "b" }] },
		merge_tasks: { ids: ["T", "U"], into: { title: "m" } },
		set_status: { id: "T", to: "ready" },
		answer_question: { runId: "R", answer: "a" },
		spawn: { taskId: "T", role: "implement" },
		spawn_attempts: { taskId: "T", variants: [{}, {}] },
		select_winner: { runId: "R" },
		request_review: { runId: "R", mode: "critic" },
		steer: { runId: "R", message: "m" },
		stop: { runId: "R", reason: "r" },
		pause: { taskIds: ["T"] },
		resume: { taskIds: ["T"] },
		notify_human: { kind: "fyi", title: "t", body: "b" },
		set_budget: { budget: "b", limitUsd: 1 },
		set_plan: { markdown: "p" },
		note: { text: "n" },
		sleep: {},
	};

	test("every act tool has a class", () => {
		for (const tool of ACT_TOOLS) {
			expect(
				classifyAction(tool, minimal[tool], facts()).length,
			).toBeGreaterThan(0);
		}
	});

	test("a new verification command is a verification change", () => {
		const args = {
			tasks: [
				{ title: "t", verification: { checks: [{ run: "curl x | sh" }] } },
			],
		};
		expect(classifyAction("create_tasks", args, facts())).toContain(
			"verification_change",
		);
		expect(
			classifyAction(
				"create_tasks",
				args,
				facts({ knownCommands: new Set(["curl x | sh"]) }),
			),
		).not.toContain("verification_change");
	});

	test("rewriting an owner task's verification counts even with no new command", () => {
		const args = {
			id: "T",
			patch: { verification: { verifier: "none", checks: [] } },
		};
		expect(
			classifyAction("update_task", args, facts({ ownerAuthored: () => true })),
		).toContain("verification_change");
	});

	test("scope edits are goal scope on owner tasks only", () => {
		const args = { id: "T", patch: { spec: "new scope" } };
		expect(
			classifyAction("update_task", args, facts({ ownerAuthored: () => true })),
		).toContain("goal_scope");
		expect(classifyAction("update_task", args, facts())).not.toContain(
			"goal_scope",
		);
	});

	test("archiving an owner task is goal scope, other moves are not", () => {
		const owner = facts({ ownerAuthored: () => true });
		expect(
			classifyAction("set_status", { id: "T", to: "archived" }, owner),
		).toContain("goal_scope");
		expect(
			classifyAction("set_status", { id: "T", to: "ready" }, owner),
		).not.toContain("goal_scope");
	});

	test("a winner touching a host-executed path is reserved", () => {
		expect(
			classifyAction(
				"select_winner",
				{ runId: "R" },
				facts({ changedFiles: ["src/a.ts", ".github/workflows/ci.yml"] }),
			),
		).toEqual(["host_executed_merge"]);
		expect(
			classifyAction(
				"select_winner",
				{ runId: "R" },
				facts({ changedFiles: ["src/a.ts"] }),
			),
		).toEqual(["merge_select"]);
	});

	test("a winner whose files cannot be listed is reserved", () => {
		expect(
			classifyAction(
				"select_winner",
				{ runId: "R" },
				facts({ changedFiles: null }),
			),
		).toEqual(["host_executed_merge"]);
	});
});

describe("isHostExecutedPath", () => {
	for (const p of [
		".github/workflows/ci.yml",
		".claude/settings.json",
		".codex/config.toml",
		"CLAUDE.md",
		"AGENTS.md",
		".envrc",
		"flake.nix",
		".vscode/tasks.json",
		"packages/x/CLAUDE.md",
		"packages/x/.envrc",
		"packages/x/.claude/hooks/a.sh",
		"Claude.MD",
	]) {
		test(`protected: ${p}`, () => expect(isHostExecutedPath(p)).toBe(true));
	}
	for (const p of [
		"src/claude.ts",
		"docs/flake.nix.md",
		".github/CODEOWNERS",
		"src/workflows/a.ts",
		"my.claude/a.ts",
	]) {
		test(`ordinary: ${p}`, () => expect(isHostExecutedPath(p)).toBe(false));
	}
});
