import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { EventBus } from "@mfw/db/eventlog";
import { events } from "@mfw/db/schema";
import { buildPrompts } from "../src/boot.ts";
import {
	ClarificationContinuationClaimedError,
	ClarifyService,
	ContinuationRunTerminalError,
	continuationTerminalError,
	type ReplanFn,
} from "../src/clarify.ts";
import { InboxService } from "../src/inbox.ts";
import { silentLogger } from "../src/log.ts";
import { RunRegistry } from "../src/run-registry.ts";
import type { TaskService } from "../src/task-service.ts";
import { makeTasks } from "./fixtures/board.ts";

/**
 * The clarify gate, end to end at the service level: raise → read → answer →
 * re-plan. The table has existed since the overhaul with no writer anywhere in
 * the codebase, so every assertion here is about a path that did not exist.
 */

interface Env {
	dir: string;
	handle: ProjectDbHandle;
	bus: EventBus;
	clarify: ClarifyService;
	replan: ReplanFn;
	tasks: TaskService;
	replans: {
		goal: string;
		answers: { question: string; answer: string }[];
		sourceRunId: string;
		continuationRunId: string;
	}[];
}

const envs: Env[] = [];

async function freshEnv(replanOverride?: ReplanFn): Promise<Env> {
	const dir = await mkdtemp(join(tmpdir(), "mfw-clarify-"));
	const handle = await openProjectDb(dir);
	const bus = new EventBus();
	const replans: Env["replans"] = [];
	const replan: ReplanFn = async (input) => {
		replans.push(input);
		return replanOverride?.(input) ?? { runId: input.continuationRunId };
	};
	const tasks = await makeTasks(handle, bus, dir);
	const env: Env = {
		dir,
		handle,
		bus,
		clarify: new ClarifyService({ handle, bus, log: silentLogger(), replan }),
		replan,
		tasks,
		replans,
	};
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

describe("ClarifyService", () => {
	test("exact continuation lookup accepts success/live rows but rejects start and terminal failures", () => {
		expect(
			continuationTerminalError({
				id: "CHILD",
				state: "ended",
				outcome: "start_failed",
			}),
		).toBeInstanceOf(ContinuationRunTerminalError);
		expect(
			continuationTerminalError({
				id: "CHILD",
				state: "failed",
				outcome: null,
			}),
		).toBeInstanceOf(ContinuationRunTerminalError);
		expect(
			continuationTerminalError({
				id: "CHILD",
				state: "running",
				outcome: null,
			}),
		).toBeNull();
		expect(
			continuationTerminalError({
				id: "CHILD",
				state: "completed",
				outcome: "completed",
			}),
		).toBeNull();
		// The plan already consumed the answers when only finalization failed.
		// Its blocked task owns recovery; launching a replacement would be both
		// duplicative and unclaimable.
		expect(
			continuationTerminalError({
				id: "CHILD",
				state: "finalize_error",
				outcome: "finalize_error",
			}),
		).toBeNull();
	});

	test("questions are persisted and surface as an open set", async () => {
		const env = await freshEnv();

		const raised = await env.clarify.raise({
			runId: "RUN1",
			kind: "planner",
			goal: "Add billing",
			questions: ["Stripe or Adyen?", "Invoice in EUR?"],
		});

		expect(raised?.openCount).toBe(2);
		expect(raised?.resolvedAt).toBeNull();
		expect(await env.clarify.list({ open: true })).toHaveLength(1);
		expect(await eventTypes(env)).toContain("clarify.raised");
	});

	test("an empty question list records nothing at all", async () => {
		const env = await freshEnv();

		expect(
			await env.clarify.raise({
				runId: "RUN1",
				kind: "planner",
				questions: ["  ", ""],
			}),
		).toBeNull();
		expect(await env.clarify.list()).toEqual([]);
		expect(await eventTypes(env)).not.toContain("clarify.raised");
	});

	test("raising twice for the same run is idempotent: the step may re-run", async () => {
		const env = await freshEnv();
		await env.clarify.raise({
			runId: "RUN1",
			kind: "planner",
			questions: ["first?"],
		});

		// A crash between the effect and its journal row replays the step.
		const second = await env.clarify.raise({
			runId: "RUN1",
			kind: "planner",
			questions: ["first?", "and a second?"],
		});

		expect(second?.items.map((i) => i.question)).toEqual(["first?"]);
		expect(await env.clarify.list()).toHaveLength(1);
		expect(
			(await eventTypes(env)).filter((t) => t === "clarify.raised"),
		).toHaveLength(1);
	});

	test("planner answers stay open until a continuation consumes them", async () => {
		const env = await freshEnv();
		await env.clarify.raise({
			runId: "RUN1",
			kind: "planner",
			goal: "Add billing",
			questions: ["Stripe or Adyen?", "Invoice in EUR?"],
		});

		const partial = await env.clarify.answer("RUN1", [
			{ index: 0, answer: "Stripe" },
		]);
		expect(partial.clarification.openCount).toBe(1);
		expect(partial.clarification.resolvedAt).toBeNull();
		expect(await env.clarify.list({ open: true })).toHaveLength(1);

		const full = await env.clarify.answer("RUN1", [
			{ index: 1, answer: "Yes, EUR" },
		]);
		expect(full.clarification.openCount).toBe(0);
		expect(full.clarification.resolvedAt).toBeNull();
		expect(full.clarification.items.map((i) => i.answer)).toEqual([
			"Stripe",
			"Yes, EUR",
		]);
		expect(await env.clarify.list({ open: true })).toHaveLength(1);
		expect(await eventTypes(env)).not.toContain("clarify.resolved");
	});

	test("answers can drive a re-plan against the ORIGINAL goal", async () => {
		const env = await freshEnv();
		await env.clarify.raise({
			runId: "RUN1",
			kind: "planner",
			goal: "Add billing",
			questions: ["Stripe or Adyen?"],
		});

		const result = await env.clarify.answer(
			"RUN1",
			[{ index: 0, answer: "Stripe" }],
			{ continuePlanning: true },
		);

		expect(result.continuation.status).toBe("started");
		if (result.continuation.status !== "started")
			throw new Error("not started");
		expect(result.clarification.resolvedAt).not.toBeNull();
		expect(env.replans).toEqual([
			{
				goal: "Add billing",
				answers: [{ question: "Stripe or Adyen?", answer: "Stripe" }],
				sourceRunId: "RUN1",
				continuationRunId: result.continuation.runId,
			},
		]);
	});

	test("a set with no goal cannot re-plan, and says so instead of pretending", async () => {
		const env = await freshEnv();
		// An importer's questions are about a repository, not a goal.
		await env.clarify.raise({
			runId: "RUN1",
			kind: "importer",
			questions: ["Is packages/legacy still shipped?"],
		});

		const result = await env.clarify.answer(
			"RUN1",
			[{ index: 0, answer: "No" }],
			{ continuePlanning: true },
		);

		expect(result.continuation).toEqual({ status: "not_requested" });
		expect(env.replans).toEqual([]);
		expect(result.clarification.resolvedAt).not.toBeNull();
	});

	test("a failed continuation preserves answers, remains actionable, and retries", async () => {
		let attempts = 0;
		const persistedChildren = new Set<string>();
		const env = await freshEnv(async (input) => {
			attempts++;
			if (attempts === 1) {
				// This is the ambiguous boundary: the child exists, but the caller did
				// not receive an acknowledgement. A retry must reuse it.
				persistedChildren.add(input.continuationRunId);
				throw new Error("launch acknowledgement lost");
			}
			expect(persistedChildren.has(input.continuationRunId)).toBe(true);
			return { runId: input.continuationRunId };
		});
		const inbox = new InboxService({
			handle: env.handle,
			project: "demo",
			tasks: env.tasks,
		});
		await env.clarify.raise({
			runId: "RUN1",
			kind: "planner",
			goal: "Add billing",
			questions: ["Stripe or Adyen?"],
		});

		const failed = await env.clarify.answer(
			"RUN1",
			[{ index: 0, answer: "Stripe" }],
			{ continuePlanning: true },
		);
		expect(failed.continuation).toEqual({
			status: "failed",
			message: "launch acknowledgement lost",
		});
		expect(failed.clarification.items[0]?.answer).toBe("Stripe");
		expect(failed.clarification.resolvedAt).toBeNull();
		const firstContinuationRunId = env.replans[0]?.continuationRunId;
		expect(firstContinuationRunId).toBeDefined();
		expect(failed.clarification.continuationRunId).toBe(
			firstContinuationRunId ?? null,
		);
		expect((await inbox.list()).find((i) => i.kind === "clarify")?.title).toBe(
			"Answers saved; continuation needs retry",
		);

		const afterRestart = new ClarifyService({
			handle: env.handle,
			bus: env.bus,
			log: silentLogger(),
			replan: env.replan,
		});
		const retried = await afterRestart.answer("RUN1", [], {
			continuePlanning: true,
		});
		expect(retried.continuation.status).toBe("started");
		expect(retried.clarification.items[0]?.answer).toBe("Stripe");
		expect(retried.clarification.resolvedAt).not.toBeNull();
		expect(attempts).toBe(2);
		expect(env.replans[1]?.continuationRunId).toBe(firstContinuationRunId);
		expect(persistedChildren.size).toBe(1);
	});

	test("concurrent and repeated continuation requests start exactly one child", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const env = await freshEnv(async (input) => {
			calls++;
			await gate;
			return { runId: input.continuationRunId };
		});
		await env.clarify.raise({
			runId: "RUN1",
			kind: "planner",
			goal: "Add billing",
			questions: ["Stripe or Adyen?"],
		});

		const first = env.clarify.answer("RUN1", [{ index: 0, answer: "Stripe" }], {
			continuePlanning: true,
		});
		const second = env.clarify.answer(
			"RUN1",
			[{ index: 0, answer: "Stripe" }],
			{ continuePlanning: true },
		);
		await Bun.sleep(5);
		expect(calls).toBe(1);
		release();
		const [a, b] = await Promise.all([first, second]);
		expect(a.continuation).toEqual(b.continuation);

		const repeated = await env.clarify.answer("RUN1", [], {
			continuePlanning: true,
		});
		expect(repeated.continuation).toEqual(a.continuation);
		expect(calls).toBe(1);
	});

	test("a claimed continuation freezes its exact answer snapshot", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let launched = false;
		const env = await freshEnv(async (input) => {
			launched = true;
			await gate;
			return { runId: input.continuationRunId };
		});
		await env.clarify.raise({
			runId: "RUN1",
			kind: "planner",
			goal: "Add billing",
			questions: ["Stripe or Adyen?"],
		});
		const first = env.clarify.answer("RUN1", [{ index: 0, answer: "Stripe" }], {
			continuePlanning: true,
		});
		while (!launched) await Bun.sleep(1);

		await expect(
			env.clarify.answer("RUN1", [{ index: 0, answer: "Adyen" }]),
		).rejects.toBeInstanceOf(ClarificationContinuationClaimedError);
		expect((await env.clarify.get("RUN1"))?.items[0]?.answer).toBe("Stripe");
		release();
		await first;
	});

	test("one retry click replaces a proven-terminal exact child without duplicating the ambiguous one", async () => {
		let attempts = 0;
		let failedChildId: string | null = null;
		const env = await freshEnv(async (input) => {
			attempts++;
			if (attempts === 1) {
				failedChildId = input.continuationRunId;
				throw new Error("launch acknowledgement lost");
			}
			if (input.continuationRunId === failedChildId) {
				throw new ContinuationRunTerminalError(
					input.continuationRunId,
					"start_failed",
				);
			}
			return { runId: input.continuationRunId };
		});
		await env.clarify.raise({
			runId: "RUN1",
			kind: "planner",
			goal: "Add billing",
			questions: ["Stripe or Adyen?"],
		});

		const ambiguous = await env.clarify.answer(
			"RUN1",
			[{ index: 0, answer: "Stripe" }],
			{ continuePlanning: true },
		);
		expect(ambiguous.continuation.status).toBe("failed");
		expect(ambiguous.clarification.resolvedAt).toBeNull();
		expect(ambiguous.clarification.continuationRunId).toBe(failedChildId);
		if (!failedChildId)
			throw new Error("first continuation id was not recorded");

		const retried = await env.clarify.answer("RUN1", [], {
			continuePlanning: true,
		});
		expect(retried.continuation.status).toBe("started");
		expect(env.replans[1]?.continuationRunId).toBe(failedChildId);
		expect(env.replans[2]?.continuationRunId).not.toBe(failedChildId);
		expect(retried.clarification.items[0]?.answer).toBe("Stripe");
		expect(retried.clarification.resolvedAt).not.toBeNull();
		expect(attempts).toBe(3);
	});

	test("dismissing closes a set without answering it", async () => {
		const env = await freshEnv();
		await env.clarify.raise({
			runId: "RUN1",
			kind: "planner",
			questions: ["Stripe or Adyen?"],
		});

		const dismissed = await env.clarify.dismiss("RUN1");

		expect(dismissed?.resolvedAt).not.toBeNull();
		expect(dismissed?.items[0]?.answer).toBeNull();
		expect(await env.clarify.list({ open: true })).toEqual([]);
	});

	test("an answer aimed at a question that does not exist is rejected", async () => {
		const env = await freshEnv();
		await env.clarify.raise({
			runId: "RUN1",
			kind: "planner",
			questions: ["only one"],
		});

		expect(
			env.clarify.answer("RUN1", [{ index: 7, answer: "x" }]),
		).rejects.toThrow("no question at index 7");
	});

	test("an open set is an inbox item; continuing it clears the item", async () => {
		const env = await freshEnv();
		const inbox = new InboxService({
			handle: env.handle,
			project: "demo",
			tasks: env.tasks,
		});
		await env.clarify.raise({
			runId: "RUN1",
			kind: "planner",
			goal: "Add billing",
			questions: ["Stripe or Adyen?"],
		});

		expect((await inbox.list()).map((i) => i.kind)).toContain("clarify");

		await env.clarify.answer("RUN1", [{ index: 0, answer: "Stripe" }], {
			continuePlanning: true,
		});

		expect((await inbox.list()).map((i) => i.kind)).not.toContain("clarify");
	});
});

describe("buildPrompts.plan: answers are spent, not archived", () => {
	test("answered questions are carried into the re-plan prompt", async () => {
		const env = await freshEnv();
		const prompts = buildPrompts(
			env.tasks,
			new RunRegistry({
				handle: env.handle,
				bus: env.bus,
				runsDir: join(env.dir, "runs"),
			}),
		);

		const plain = await prompts.plan("Add billing");
		const replan = await prompts.plan("Add billing", [
			{ question: "Stripe or Adyen?", answer: "Stripe" },
		]);

		expect(plain).not.toContain("Answers to your earlier questions");
		expect(replan).toContain("Answers to your earlier questions");
		expect(replan).toContain("Stripe or Adyen?");
		expect(replan).toContain("Stripe");
		expect(replan).toContain("do not ask them again");
	});
});
