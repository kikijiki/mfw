import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { decisions, events } from "@mfw/db/schema";
import { silentLogger } from "../src/log.ts";
import { RunRegistry } from "../src/run-registry.ts";
import { NotFoundError, SessionService } from "../src/session.ts";
import type { TaskService } from "../src/task-service.ts";
import { makeTasks } from "./fixtures/board.ts";

/**
 * MFW-59: `SessionService` composes and stores the pre-loaded brief the
 * moment an escalation site raises one, then gates opening it (spends
 * nothing until a human asks) and closing it (must resolve something).
 */

interface Env {
	dir: string;
	handle: ProjectDbHandle;
	bus: EventBus;
	tasks: TaskService;
	registry: RunRegistry;
	sessions: SessionService;
}

const envs: Env[] = [];

async function freshEnv(): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-session-"));
	const handle = await openProjectDb(dir);
	const bus = new EventBus();
	const tasks = await makeTasks(handle, bus, dir);
	const registry = new RunRegistry({ handle, bus, runsDir: join(dir, "runs") });
	const sessions = new SessionService({
		handle,
		bus,
		log: silentLogger(),
		project: "demo",
		tasks,
		registry,
	});
	const env: Env = { dir, handle, bus, tasks, registry, sessions };
	envs.push(env);
	return env;
}

const eventTypes = async (env: Env): Promise<string[]> =>
	(await env.handle.db.select().from(events)).map((e) => e.type);

afterEach(async () => {
	for (const env of envs.splice(0)) {
		env.handle.close();
		await rm(env.dir, { recursive: true, force: true });
	}
});

describe("SessionService.raise: composing the brief", () => {
	test("stores a session with every supplied fact rendered into its context", async () => {
		const env = await freshEnv();
		const raised = await env.sessions.raise({
			source: "main_red",
			sourceKey: "MFW-1",
			taskId: "MFW-1",
			title: "main is red: MFW-1 has not cleared",
			summary: "the sweep keeps failing on MFW-1",
			whatWasTried: ["re-verified 3 times", "corroborated against green"],
			environment: "an ephemeral worktree, not your shell",
			hypothesis: "mfw believes this is a real regression",
		});

		expect(raised?.id).toBeTruthy();
		const session = await env.sessions.get(raised?.id as string);
		expect(session?.source).toBe("main_red");
		expect(session?.title).toBe("main is red: MFW-1 has not cleared");
		expect(session?.context).toContain("the sweep keeps failing on MFW-1");
		expect(session?.context).toContain("re-verified 3 times");
		expect(session?.context).toContain("corroborated against green");
		expect(session?.context).toContain("an ephemeral worktree, not your shell");
		expect(session?.context).toContain(
			"mfw believes this is a real regression",
		);
		expect(session?.resolvedAt).toBeNull();
		expect(session?.openedRunId).toBeNull();
		expect(await eventTypes(env)).toContain("session.raised");
	});

	test("composing costs nothing beyond the row, no run starts", async () => {
		const env = await freshEnv();
		let started = 0;
		env.sessions.startSession = async () => {
			started++;
			return { runId: "should-not-happen" };
		};
		await env.sessions.raise({
			source: "blocked",
			sourceKey: "MFW-2",
			taskId: "MFW-2",
			title: "blocked: MFW-2",
			summary: "repairs exhausted",
			whatWasTried: [],
			environment: "an isolated worktree",
		});
		expect(started).toBe(0);
	});

	test("raising twice for the same open episode is a no-op", async () => {
		const env = await freshEnv();
		const input = {
			source: "blocked" as const,
			sourceKey: "MFW-3",
			taskId: "MFW-3",
			title: "blocked: MFW-3",
			summary: "repairs exhausted",
			whatWasTried: [],
			environment: "an isolated worktree",
		};
		const first = await env.sessions.raise(input);
		const second = await env.sessions.raise(input);

		expect(first?.id).toBeTruthy();
		expect(second).toBeNull();
		expect(await env.sessions.list()).toHaveLength(1);
		expect(
			(await eventTypes(env)).filter((t) => t === "session.raised"),
		).toHaveLength(1);
	});

	test("a fresh escalation after resolution raises a NEW session", async () => {
		const env = await freshEnv();
		const input = {
			source: "merge_parked" as const,
			sourceKey: "7",
			mergeJobId: 7,
			title: "merge parked: mfw/task-7",
			summary: "rebase conflict",
			whatWasTried: [],
			environment: "the run's own worktree",
		};
		const first = await env.sessions.raise(input);
		await env.sessions.resolve(first?.id as string, "retried");

		const second = await env.sessions.raise(input);
		expect(second?.id).toBeTruthy();
		expect(second?.id).not.toBe(first?.id);
		expect(await env.sessions.list()).toHaveLength(2);
		expect(await env.sessions.list({ open: true })).toHaveLength(1);
	});

	test("a taskId pulls the task's own title, body and criteria into the brief", async () => {
		const env = await freshEnv();
		const task = await env.tasks.create({
			title: "add the widget",
			body: "make it spin",
			criteria: [{ text: "spins on click", checked: true }],
		});

		const raised = await env.sessions.raise({
			source: "blocked",
			sourceKey: task.id,
			taskId: task.id,
			title: `blocked: ${task.id}`,
			summary: "repairs exhausted",
			whatWasTried: [],
			environment: "an isolated worktree",
		});
		const session = await env.sessions.get(raised?.id as string);
		expect(session?.context).toContain("add the widget");
		expect(session?.context).toContain("make it spin");
		expect(session?.context).toContain("spins on click");
	});

	test("a runId pulls the run's worktree/branch and the verify step's tail", async () => {
		const env = await freshEnv();
		const run = await env.registry.create({
			kind: "task",
			taskId: "MFW-5",
			label: "MFW-5",
			model: "sonnet",
			cwd: "/tmp/wt",
			worktreePath: "/tmp/wt",
			branch: "mfw/MFW-5",
		});
		await env.registry.beginStep(run.id, "verify");
		await env.registry.finishStep(run.id, "verify", {
			passed: false,
			checks: [
				{
					check: "bun test",
					ok: false,
					classification: "failed",
					detail: "expect(1).toBe(2)\n  at test.ts:12",
				},
			],
		});

		const raised = await env.sessions.raise({
			source: "blocked",
			sourceKey: "MFW-5",
			taskId: "MFW-5",
			runId: run.id,
			title: "blocked: MFW-5",
			summary: "repairs exhausted",
			whatWasTried: [],
			environment: "an isolated worktree",
		});
		const session = await env.sessions.get(raised?.id as string);
		expect(session?.context).toContain("/tmp/wt");
		expect(session?.context).toContain("mfw/MFW-5");
		expect(session?.context).toContain("Last check output (tail, not head)");
		expect(session?.context).toContain("bun test");
		expect(session?.context).toContain("expect(1).toBe(2)");
	});

	test("the brain's recent decisions for the task surface in the brief", async () => {
		const env = await freshEnv();
		await env.handle.db.insert(decisions).values({
			ts: new Date(),
			role: "replan",
			taskId: "MFW-6",
			model: "sonnet",
			status: "ok",
			action: "escalate",
			reason: "no repair path looked promising",
			finishedAt: new Date(),
		});

		const raised = await env.sessions.raise({
			source: "blocked",
			sourceKey: "MFW-6",
			taskId: "MFW-6",
			title: "blocked: MFW-6",
			summary: "repairs exhausted",
			whatWasTried: [],
			environment: "an isolated worktree",
		});
		const session = await env.sessions.get(raised?.id as string);
		expect(session?.context).toContain("The brain's recent involvement");
		expect(session?.context).toContain("replan");
		expect(session?.context).toContain("escalate");
		expect(session?.context).toContain("no repair path looked promising");
	});
});

describe("SessionService.open: the run that actually costs something", () => {
	test("throws when no run engine is wired", async () => {
		const env = await freshEnv();
		const raised = await env.sessions.raise({
			source: "blocked",
			sourceKey: "MFW-7",
			taskId: "MFW-7",
			title: "blocked: MFW-7",
			summary: "repairs exhausted",
			whatWasTried: [],
			environment: "an isolated worktree",
		});
		expect(env.sessions.open(raised?.id as string)).rejects.toThrow(
			"no run engine wired",
		);
	});

	test("reuses the linked run's worktree and branch", async () => {
		const env = await freshEnv();
		const run = await env.registry.create({
			kind: "task",
			taskId: "MFW-8",
			label: "MFW-8",
			model: "sonnet",
			cwd: "/tmp/wt8",
			worktreePath: "/tmp/wt8",
			branch: "mfw/MFW-8",
			baseSha: "deadbeef",
		});
		const seen: unknown[] = [];
		env.sessions.startSession = async (prompt, opts) => {
			seen.push({ prompt, opts });
			return { runId: "session-run-1" };
		};
		const raised = await env.sessions.raise({
			source: "blocked",
			sourceKey: "MFW-8",
			taskId: "MFW-8",
			runId: run.id,
			title: "blocked: MFW-8",
			summary: "repairs exhausted",
			whatWasTried: [],
			environment: "an isolated worktree",
		});

		const { runId } = await env.sessions.open(raised?.id as string);
		expect(runId).toBe("session-run-1");
		expect(seen).toEqual([
			{
				prompt: (await env.sessions.get(raised?.id as string))?.context,
				opts: {
					reuse: {
						worktreePath: "/tmp/wt8",
						branch: "mfw/MFW-8",
						baseSha: "deadbeef",
					},
				},
			},
		]);
		const after = await env.sessions.get(raised?.id as string);
		expect(after?.openedRunId).toBe("session-run-1");
		expect(after?.openedAt).not.toBeNull();
		expect(await eventTypes(env)).toContain("session.opened");
	});

	test("no worktree to reuse (e.g. main_red) starts fresh", async () => {
		const env = await freshEnv();
		const seen: unknown[] = [];
		env.sessions.startSession = async (_prompt, opts) => {
			seen.push(opts);
			return { runId: "session-run-2" };
		};
		const raised = await env.sessions.raise({
			source: "main_red",
			sourceKey: "MFW-9",
			taskId: "MFW-9",
			title: "main is red",
			summary: "still failing",
			whatWasTried: [],
			environment: "an ephemeral sweep worktree",
		});
		await env.sessions.open(raised?.id as string);
		expect(seen).toEqual([{ reuse: undefined }]);
	});

	test("opening an already-opened session is idempotent, no second run", async () => {
		const env = await freshEnv();
		let calls = 0;
		env.sessions.startSession = async () => {
			calls++;
			return { runId: `run-${calls}` };
		};
		const raised = await env.sessions.raise({
			source: "blocked",
			sourceKey: "MFW-10",
			taskId: "MFW-10",
			title: "blocked: MFW-10",
			summary: "repairs exhausted",
			whatWasTried: [],
			environment: "an isolated worktree",
		});
		const first = await env.sessions.open(raised?.id as string);
		const second = await env.sessions.open(raised?.id as string);
		expect(first.runId).toBe("run-1");
		expect(second.runId).toBe("run-1");
		expect(calls).toBe(1);
	});

	test("an unknown session id is rejected as NOT_FOUND", async () => {
		const env = await freshEnv();
		expect(env.sessions.open("nope")).rejects.toThrow(NotFoundError);
	});
});

describe("SessionService.resolve: closing must resolve something", () => {
	test("dismissing without a reason is refused", async () => {
		const env = await freshEnv();
		const raised = await env.sessions.raise({
			source: "blocked",
			sourceKey: "MFW-11",
			taskId: "MFW-11",
			title: "blocked: MFW-11",
			summary: "repairs exhausted",
			whatWasTried: [],
			environment: "an isolated worktree",
		});
		expect(
			env.sessions.resolve(raised?.id as string, "dismissed"),
		).rejects.toThrow("needs a reason");
		expect(
			(await env.sessions.get(raised?.id as string))?.resolvedAt,
		).toBeNull();
	});

	test("dismissing with a reason clears the mapped inbox item", async () => {
		const env = await freshEnv();
		const dismissed: string[] = [];
		env.sessions.dismissInboxItem = async (itemId) => {
			dismissed.push(itemId);
		};
		const raised = await env.sessions.raise({
			source: "merge_parked",
			sourceKey: "42",
			mergeJobId: 42,
			title: "merge parked",
			summary: "rebase conflict",
			whatWasTried: [],
			environment: "the run's own worktree",
		});
		await env.sessions.resolve(
			raised?.id as string,
			"dismissed",
			"branch abandoned, not worth resolving",
		);

		const session = await env.sessions.get(raised?.id as string);
		expect(session?.resolution).toBe("dismissed");
		expect(session?.resolutionReason).toBe(
			"branch abandoned, not worth resolving",
		);
		expect(session?.resolvedAt).not.toBeNull();
		expect(dismissed).toEqual(["merge_parked:42"]);
		expect(await eventTypes(env)).toContain("session.resolved");
	});

	test("resolving 'fixed' or 'retried' needs no reason and does not touch the inbox", async () => {
		const env = await freshEnv();
		let dismissed = 0;
		env.sessions.dismissInboxItem = async () => {
			dismissed++;
		};
		const raised = await env.sessions.raise({
			source: "blocked",
			sourceKey: "MFW-12",
			taskId: "MFW-12",
			title: "blocked: MFW-12",
			summary: "repairs exhausted",
			whatWasTried: [],
			environment: "an isolated worktree",
		});
		await env.sessions.resolve(raised?.id as string, "fixed");
		expect((await env.sessions.get(raised?.id as string))?.resolution).toBe(
			"fixed",
		);
		expect(dismissed).toBe(0);
	});

	test("resolving twice is a harmless no-op", async () => {
		const env = await freshEnv();
		const raised = await env.sessions.raise({
			source: "blocked",
			sourceKey: "MFW-13",
			taskId: "MFW-13",
			title: "blocked: MFW-13",
			summary: "repairs exhausted",
			whatWasTried: [],
			environment: "an isolated worktree",
		});
		await env.sessions.resolve(raised?.id as string, "fixed");
		await env.sessions.resolve(
			raised?.id as string,
			"dismissed",
			"changed mind",
		);
		const session = await env.sessions.get(raised?.id as string);
		expect(session?.resolution).toBe("fixed"); // first resolution sticks
	});

	test("the three sources map to InboxService's own item ids", async () => {
		const env = await freshEnv();
		const dismissed: string[] = [];
		env.sessions.dismissInboxItem = async (itemId) => {
			dismissed.push(itemId);
		};
		const mainRed = await env.sessions.raise({
			source: "main_red",
			sourceKey: "MFW-14",
			taskId: "MFW-14",
			title: "main is red",
			summary: "x",
			whatWasTried: [],
			environment: "x",
		});
		const parked = await env.sessions.raise({
			source: "merge_parked",
			sourceKey: "99",
			mergeJobId: 99,
			title: "merge parked",
			summary: "x",
			whatWasTried: [],
			environment: "x",
		});
		const blocked = await env.sessions.raise({
			source: "blocked",
			sourceKey: "MFW-15",
			taskId: "MFW-15",
			title: "blocked",
			summary: "x",
			whatWasTried: [],
			environment: "x",
		});
		await env.sessions.resolve(mainRed?.id as string, "dismissed", "r");
		await env.sessions.resolve(parked?.id as string, "dismissed", "r");
		await env.sessions.resolve(blocked?.id as string, "dismissed", "r");

		expect(dismissed).toEqual([
			"main_red:demo:MFW-14",
			"merge_parked:99",
			"blocked:MFW-15",
		]);
	});

	test("an unknown session id is rejected as NOT_FOUND", async () => {
		const env = await freshEnv();
		expect(env.sessions.resolve("nope", "fixed")).rejects.toThrow(
			NotFoundError,
		);
	});
});
