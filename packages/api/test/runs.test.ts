import { describe, expect, test } from "bun:test";
import { RunLiveError } from "@mfw/daemon/lifecycle";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, createCaller } from "../src/root.ts";

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

/** Title lookups per project; `get` throws so a per-row lookup (the old N+1) fails loudly. */
function project(name: string, rows: unknown[], lookups: string[][] = []) {
	const runRows = rows as (typeof row)[];
	return {
		name,
		registry: {
			list: async () => runRows,
			get: async (id: string) => runRows.find((run) => run.id === id) ?? null,
		},
		tasks: {
			get: async () => {
				throw new Error("per-row tasks.get: use tasks.titles");
			},
			titles: (ids: Iterable<string>) => {
				const list = [...ids];
				lookups.push(list);
				return new Map(list.map((id) => [id, "Build the harness"]));
			},
		},
	} as unknown as ProjectServices;
}

function callerFor(...services: ProjectServices[]) {
	const orchestrator = {
		list: () => services,
		get: (name: string) => {
			const svc = services.find((s) => s.name === name);
			if (!svc) throw new Error("unknown project");
			return svc;
		},
	} as unknown as Orchestrator;
	return createCaller({ orchestrator });
}

function caller(rows: unknown[] = [row], lookups: string[][] = []) {
	return callerFor(project("demo", rows, lookups));
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

	test("get exposes the harness's native session id, null until reported", async () => {
		const withSession = { ...row, nativeSessionId: "thread-7f3a" };
		const without = { ...row, id: "01NONE", nativeSessionId: null };
		const api = caller([withSession, without]);
		expect(
			await api.runs.get({ project: "demo", runId: "01RUN" }),
		).toMatchObject({ nativeSessionId: "thread-7f3a" });
		expect(
			await api.runs.get({ project: "demo", runId: "01NONE" }),
		).toMatchObject({ nativeSessionId: null });
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

describe("run activity", () => {
	const detail = {
		pendingApprovals: ["r1"],
		approvalSummary: "rm -rf dist",
		background: [],
		turns: 3,
		lastEventAt: null,
	};

	test("active carries activity, its detail and the scope sample", async () => {
		const [active] = await caller([
			{
				...row,
				activity: "awaiting_approval",
				activityDetail: detail,
				scopeSample: { files: 3, outside: 0, foreign: 0 },
			},
		]).runs.active();
		expect(active).toMatchObject({
			activity: "awaiting_approval",
			activityDetail: detail,
			scopeSample: { files: 3, outside: 0, foreign: 0 },
		});
	});

	test("an unknown or missing stored activity reads as null", async () => {
		const [legacy] = await caller([{ ...row }]).runs.active();
		expect(legacy?.activity).toBeNull();
		const [odd] = await caller([{ ...row, activity: "dancing" }]).runs.active();
		expect(odd?.activity).toBeNull();
	});

	test("runs.activity answers for one run", async () => {
		const api = caller([
			{ ...row, activity: "needs_answer", activityDetail: detail },
		]);
		expect(
			await api.runs.activity({ project: "demo", runId: "01RUN" }),
		).toEqual({
			runId: "01RUN",
			state: "running",
			activity: "needs_answer",
			detail,
		});
		expect(
			await api.runs.activity({ project: "demo", runId: "missing" }),
		).toBeNull();
	});
});

describe("batch task lookup", () => {
	const many = Array.from({ length: 30 }, (_, i) => ({
		...row,
		id: `01RUN${String(i).padStart(2, "0")}`,
		taskId: `MFW-${i % 10}`,
		startedAt: new Date(Date.UTC(2026, 7, 19, 0, i)),
	}));

	test("list resolves every task title in one lookup, deduplicated", async () => {
		const lookups: string[][] = [];
		const listed = await caller(many, lookups).runs.list({
			project: "demo",
			limit: 50,
		});
		expect(listed).toHaveLength(30);
		expect(listed.every((r) => r.taskTitle === "Build the harness")).toBe(true);
		expect(lookups).toHaveLength(1);
		expect(lookups[0]?.length).toBe(10);
	});

	test("active resolves titles once per project", async () => {
		const lookups: string[][] = [];
		const active = await caller(many, lookups).runs.active();
		expect(active).toHaveLength(30);
		expect(lookups).toHaveLength(1);
	});

	test("a taskless run asks for no title", async () => {
		const lookups: string[][] = [];
		const [got] = await caller(
			[{ ...row, taskId: null, kind: "plan" }],
			lookups,
		).runs.list({ project: "demo", limit: 5 });
		expect(got?.taskTitle).toBeNull();
		expect(lookups).toEqual([[]]);
	});
});

describe("runs.listAll (global Agents page)", () => {
	test("merges projects live-first then newest, and tags each row with its project", async () => {
		const done = {
			...row,
			id: "01A_DONE",
			state: "completed",
			startedAt: new Date("2026-08-19T05:00:00Z"),
			finishedAt: new Date("2026-08-19T05:10:00Z"),
		};
		const live = { ...row, id: "01B_LIVE" };
		const brain = {
			...row,
			id: "01B_BRAIN",
			kind: "brain",
			startedAt: new Date("2026-08-19T06:00:00Z"),
		};
		const lookups: string[][] = [];
		const api = callerFor(
			project("alpha", [done], lookups),
			project("beta", [live, brain], lookups),
		);
		const rows = await api.runs.listAll({ limit: 10 });
		expect(rows.map((r) => [r.project, r.id])).toEqual([
			["beta", "01B_LIVE"],
			["alpha", "01A_DONE"],
		]);
		// Heavy launch fields stay on runs.get.
		expect(rows[0]).not.toHaveProperty("initialPrompt");
		expect(rows[0]).not.toHaveProperty("argv");
		expect(rows[0]?.taskTitle).toBe("Build the harness");
		expect(lookups).toHaveLength(2);
	});

	test("the limit applies to the merged list", async () => {
		const api = callerFor(
			project("alpha", [{ ...row, id: "01A" }]),
			project("beta", [{ ...row, id: "01B" }]),
		);
		expect(await api.runs.listAll({ limit: 1 })).toHaveLength(1);
		expect(await api.runs.listAll()).toHaveLength(2);
	});
});

describe("refusals carry their fix over the wire", () => {
	test("a refused discard is PRECONDITION_FAILED with data.fix", async () => {
		const svc = {
			name: "demo",
			lifecycle: {
				discardRun: async (runId: string) => {
					throw new RunLiveError(runId, "running");
				},
			},
		} as unknown as ProjectServices;
		const orchestrator = {
			list: () => [svc],
			get: () => svc,
		} as unknown as Orchestrator;
		const res = await fetchRequestHandler({
			endpoint: "/trpc",
			router: appRouter,
			req: new Request("http://localhost/trpc/runs.discard", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ json: { project: "demo", runId: "01RUN" } }),
			}),
			createContext: () => ({ orchestrator }),
		});
		const body = (await res.json()) as {
			error: { json: { data: { code: string; fix: unknown } } };
		};
		expect(body.error.json.data.code).toBe("PRECONDITION_FAILED");
		expect(body.error.json.data.fix).toEqual({
			kind: "ui",
			text: expect.stringContaining("Stop run 01RUN"),
		});
	});
});
