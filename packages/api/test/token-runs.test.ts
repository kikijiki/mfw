import { describe, expect, test } from "bun:test";
import type { TokenPrincipal } from "@mfw/daemon/auth/service";
import type { Orchestrator, ProjectServices } from "@mfw/daemon/services";
import { appRouter } from "../src/root.ts";
import { createCallerFactory, type TokenAuditSink } from "../src/trpc.ts";

/** `runs:act` covers task runs. The brain's and other internal runs are not its. */

const audit: TokenAuditSink = { begin: async () => 1, finish: async () => {} };
const project = "demo";
const OTHER_KINDS = ["brain", "plan", "action", "import", "repair"];

function fixture() {
	const rows = new Map(
		["task", ...OTHER_KINDS].map((kind) => [
			`run-${kind}`,
			{
				id: `run-${kind}`,
				kind,
				taskId: kind === "task" ? "T1" : null,
				state: "running",
				startedAt: new Date(1),
				routing: null,
				prompt: `the ${kind} prompt`,
			},
		]),
	);
	const reads: string[] = [];
	const stops: string[] = [];
	const svc = {
		name: project,
		registry: {
			get: async (id: string) => rows.get(id) ?? null,
			list: async () => [...rows.values()],
			provenance: async () => null,
			readOutput: async (id: string) => {
				reads.push(id);
				return { chunk: "", size: 0, complete: true };
			},
		},
		engine: {
			stop: async (id: string) => {
				stops.push(id);
			},
		},
		tasks: { titles: () => new Map() },
		supervisor: { wake() {} },
		handle: undefined,
	} as unknown as ProjectServices;
	const orchestrator = {
		list: () => [svc],
		get: () => svc,
	} as unknown as Orchestrator;
	const factory = createCallerFactory(appRouter);
	const token = factory({
		orchestrator,
		tokenAudit: audit,
		principal: {
			kind: "token",
			id: "token:t1",
			tokenId: "t1",
			name: "ci",
			scopes: ["runs:act"],
			project: null,
		} satisfies TokenPrincipal,
	});
	const owner = factory({
		orchestrator,
		principal: { kind: "owner", id: "o1", sessionId: "s1" },
	});
	return { token, owner, reads, stops };
}

describe("a token and a run that is not a task run", () => {
	for (const kind of OTHER_KINDS) {
		const runId = `run-${kind}`;

		test(`runs.get refuses a ${kind} run`, async () => {
			const f = fixture();
			await expect(f.token.runs.get({ project, runId })).rejects.toMatchObject({
				code: "NOT_FOUND",
			});
		});

		test(`runs.entries refuses a ${kind} run and reads nothing`, async () => {
			const f = fixture();
			await expect(
				f.token.runs.entries({ project, runId }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(f.reads).toEqual([]);
		});

		test(`runs.stop refuses a ${kind} run and stops nothing`, async () => {
			const f = fixture();
			await expect(f.token.runs.stop({ project, runId })).rejects.toMatchObject(
				{ code: "NOT_FOUND" },
			);
			expect(f.stops).toEqual([]);
		});

		test(`live.runOutput refuses a ${kind} run`, async () => {
			const f = fixture();
			await expect(
				f.token.live.runOutput({ project, runId }),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
		});
	}

	test("an unknown run is the same refusal", async () => {
		const f = fixture();
		await expect(
			f.token.runs.get({ project, runId: "nope" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("runs.list shows task runs only", async () => {
		const f = fixture();
		const rows = await f.token.runs.list({ project });
		expect(rows.map((r) => r.kind)).toEqual(["task"]);
	});
});

describe("a task run", () => {
	test("is reachable through all four", async () => {
		const f = fixture();
		const runId = "run-task";
		expect((await f.token.runs.get({ project, runId }))?.id).toBe(runId);
		await f.token.runs.entries({ project, runId });
		expect(f.reads).toEqual([runId]);
		await f.token.runs.stop({ project, runId });
		expect(f.stops).toEqual([runId]);
		await f.token.live.runOutput({ project, runId });
	});
});

describe("the owner", () => {
	test("still reads and stops any run", async () => {
		const f = fixture();
		const runId = "run-brain";
		expect((await f.owner.runs.get({ project, runId }))?.id).toBe(runId);
		await f.owner.runs.stop({ project, runId });
		expect(f.stops).toEqual([runId]);
	});
});
