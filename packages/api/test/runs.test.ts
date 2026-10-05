import { describe, expect, test } from "bun:test";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { createCaller } from "../src/root.ts";

const capabilities = {
	verified: true,
	steer: true,
	interrupt: true,
	approvals: true,
	plan: true,
	fileChanges: true,
	commandProgress: true,
	mcp: true,
};

const row = {
	id: "01RUN",
	kind: "task",
	taskId: "MFW-1",
	parentRunId: null,
	label: "MFW-1",
	model: "gpt-5.6-sol",
	providerId: "codex-cli",
	reasoningEffort: "high",
	cwd: "/tmp/worktree",
	worktreePath: "/tmp/worktree",
	branch: "mfw/01RUN",
	integrationBranch: "main",
	baseSha: "abc",
	attempt: 1,
	resumeOrdinal: 0,
	maxRepairs: 2,
	argv: ["codex", "app-server"],
	initialPrompt: "do it",
	goal: null,
	state: "running",
	outcome: null,
	capabilities,
	finalizeOwner: null,
	finalizeClaimedAt: null,
	exitCode: null,
	killReason: null,
	note: null,
	usage: null,
	startedAt: new Date("2026-08-19T00:00:00Z"),
	finishedAt: null,
};

function caller(rows: unknown[] = [row]) {
	const runRows = rows as (typeof row)[];
	const svc = {
		name: "demo",
		registry: {
			list: async () => runRows,
			get: async (id: string) => runRows.find((run) => run.id === id) ?? null,
		},
		tasks: {
			get: async () => ({ title: "Build the harness" }),
		},
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	return createCaller({ orchestrator });
}

describe("runs launch metadata contract", () => {
	test("active exposes provider, effort, and verified rich capabilities", async () => {
		const [active] = await caller().runs.active();
		expect(active).toMatchObject({
			runId: "01RUN",
			taskTitle: "Build the harness",
			providerId: "codex-cli",
			reasoningEffort: "high",
			capabilities,
			steerable: true,
		});
	});

	test("list and get retain persisted launch metadata", async () => {
		const api = caller();
		const [listed] = await api.runs.list({ project: "demo", limit: 50 });
		const found = await api.runs.get({ project: "demo", runId: "01RUN" });
		expect(listed).toMatchObject({
			providerId: "codex-cli",
			reasoningEffort: "high",
			capabilities,
			taskTitle: "Build the harness",
		});
		expect(found).toMatchObject({
			providerId: "codex-cli",
			reasoningEffort: "high",
			capabilities,
			taskTitle: "Build the harness",
		});
	});

	test("list hides brain diagnostics and puts a live Codex session first", async () => {
		const completed = {
			...row,
			id: "01DONE",
			state: "succeeded",
			startedAt: new Date("2026-08-19T02:00:00Z"),
			finishedAt: new Date("2026-08-19T02:01:00Z"),
		};
		const brain = {
			...row,
			id: "01BRAIN",
			kind: "brain",
			taskId: null,
			label: "brain decision",
			providerId: null,
			startedAt: new Date("2026-08-19T03:00:00Z"),
		};
		const api = caller([completed, brain, row]);

		const visible = await api.runs.list({ project: "demo", limit: 50 });
		expect(visible.map((run) => run.id)).toEqual(["01RUN", "01DONE"]);

		const diagnostic = await api.runs.list({
			project: "demo",
			limit: 50,
			includeInternal: true,
		});
		expect(diagnostic.map((run) => run.id)).toEqual([
			"01BRAIN",
			"01RUN",
			"01DONE",
		]);
	});

	test("active omits current brain decisions", async () => {
		const brain = {
			...row,
			id: "01BRAIN",
			kind: "brain",
			taskId: null,
			providerId: null,
		};
		const active = await caller([brain, row]).runs.active();

		expect(active.map((run) => run.runId)).toEqual(["01RUN"]);
		expect(active[0]?.providerId).toBe("codex-cli");
	});
});
