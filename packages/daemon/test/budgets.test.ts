import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openProjectDb } from "@mfw/db/client";
import { dispatchAdmissions, events } from "@mfw/db/schema";
import { recordSpend } from "@mfw/db/spend";
import { eq } from "drizzle-orm";
import {
	BudgetService,
	keyMatches,
	resolveBudgets,
	resourceKeysOfTask,
	windowBounds,
} from "../src/budgets.ts";
import { type StoredBudgets, saveConfig } from "../src/config.ts";
import { InboxService } from "../src/inbox.ts";
import { silentLogger } from "../src/log.ts";
import { ProviderHoldStore } from "../src/provider-holds.ts";
import { type RoutingSettings, routeRun } from "../src/routing.ts";
import { type BrainFixture, brainFixture } from "./support/brain-fixture.ts";
import { brainSpawn, STUB_BRAIN } from "./support/brain-spawn.ts";
import { type BrainUnit, brainUnit } from "./support/brain-unit.ts";

let u: BrainUnit | undefined;
afterEach(async () => {
	await u?.cleanup();
	u = undefined;
});

const JAN = Date.UTC(2027, 0, 20, 12, 0, 0);

async function harness(
	budgets: StoredBudgets,
	opts: { machine?: StoredBudgets } = {},
) {
	u = await brainUnit();
	u.clock.t = JAN;
	const home = join(u.root, "home");
	await mkdir(home, { recursive: true });
	if (opts.machine) {
		await saveConfig({ projects: [], budgets: opts.machine }, home);
	}
	const holds = ProviderHoldStore.at(home, () => u?.clock.t ?? 0);
	const stops: string[] = [];
	const svc = new BudgetService({
		handle: u.handle,
		bus: u.bus,
		log: silentLogger(),
		mfwHome: home,
		project: "unit",
		stored: budgets,
		holds,
		registry: u.registry,
		stopRun: async (id) => {
			stops.push(id);
		},
		now: () => u?.clock.t ?? 0,
		minIntervalMs: 0,
	});
	const inbox = new InboxService({
		handle: u.handle,
		project: "unit",
		tasks: u.tasks,
		budgets: svc,
	});
	const unit = u;
	return {
		u: unit,
		home,
		holds,
		stops,
		svc,
		inbox,
		spend: (accountKey: string, usd: number, kind = "resource" as const) =>
			recordSpend(unit.handle.db, {
				kind,
				accountKey,
				source: kind === "resource" ? "runpod_billing" : "run_usage",
				usd,
				ts: new Date(unit.clock.t),
			}),
		eventsOf: async (type: string) =>
			unit.handle.db.select().from(events).where(eq(events.type, type)),
		budgetItems: async () =>
			(await inbox.list()).filter((i) => i.kind === "budget"),
		liveRun: async (
			id: string,
			over: { executionTarget?: string; hostId?: string } = {},
		) => {
			await unit.registry.create({
				id,
				kind: "task",
				label: id,
				model: "sonnet",
				providerId: "claude-cli",
				cwd: unit.root,
				executionTarget: over.executionTarget ?? "local",
				...(over.hostId ? { hostId: over.hostId } : {}),
			});
			await unit.registry.transition(id, "running", { from: "starting" });
		},
	};
}

const RUNPOD: StoredBudgets = {
	resources: {
		"runpod:main": {
			window: "month",
			limitUsd: 100,
			warnAt: 0.8,
			liveRunPolicy: "stop",
		},
	},
};

describe("pure helpers", () => {
	test("windows are UTC calendar or epoch-aligned and always contain now", () => {
		const day = windowBounds("day", JAN);
		expect(day).toEqual({
			start: Date.UTC(2027, 0, 20),
			end: Date.UTC(2027, 0, 21),
		});
		expect(windowBounds("month", JAN)).toEqual({
			start: Date.UTC(2027, 0, 1),
			end: Date.UTC(2027, 1, 1),
		});
		// 2027-01-20 is a Wednesday: the week starts Monday the 18th.
		expect(windowBounds("week", JAN).start).toBe(Date.UTC(2027, 0, 18));
		const five = windowBounds("5h", JAN);
		expect(five.end - five.start).toBe(5 * 3_600_000);
		expect(five.start <= JAN && JAN < five.end).toBe(true);
	});

	test("keys match exactly or by a trailing * on either side", () => {
		expect(keyMatches("runpod:main", "runpod:main")).toBe(true);
		expect(keyMatches("runpod:*", "runpod:main")).toBe(true);
		expect(keyMatches("runpod:main", "runpod:*")).toBe(true);
		expect(keyMatches("runpod:main", "runpod:other")).toBe(false);
		expect(keyMatches("host:a", "runpod:*")).toBe(false);
	});

	test("a task's resource keys come from its requirements and its target", () => {
		expect(
			resourceKeysOfTask({
				requiresResources: ["gpu", { id: "db" }],
				executionTarget: "runpod",
			}),
		).toEqual(["gpu", "db", "runpod:*"]);
		expect(resourceKeysOfTask({ executionTarget: "ssh:box" })).toEqual([
			"host:box",
		]);
		expect(resourceKeysOfTask({ executionTarget: "local" })).toEqual([]);
	});

	test("a project can only tighten a machine ceiling", () => {
		const machine: StoredBudgets = {
			agents: { "claude-cli": { window: "day", limitUsd: 10 } },
		};
		const looser = resolveBudgets(machine, {
			agents: { "claude-cli": { window: "day", limitUsd: 50 } },
		});
		expect(looser).toHaveLength(1);
		expect(looser[0]).toMatchObject({ scope: "machine", limit: 10 });
		const tighter = resolveBudgets(machine, {
			agents: { "claude-cli": { window: "day", limitUsd: 5 } },
		});
		expect(tighter).toHaveLength(1);
		expect(tighter[0]).toMatchObject({ scope: "project", limit: 5 });
	});
});

describe("resource budgets (P5a)", () => {
	test("crossing the RunPod monthly limit holds runpod:* admissions, stops live pods, raises exactly one inbox item", async () => {
		const h = await harness(RUNPOD);
		await h.liveRun("POD-1", { executionTarget: "runpod" });
		await h.liveRun("LOCAL-1");
		await h.spend("runpod:main", 60);
		await h.svc.evaluate();
		// Under the limit: nothing held, nothing stopped, no item.
		expect(await h.svc.holdFor({ executionTarget: "runpod" })).toBeNull();
		expect(h.stops).toEqual([]);
		expect(await h.budgetItems()).toHaveLength(0);

		await h.spend("runpod:main", 50);
		await h.svc.evaluate();

		const held = await h.svc.holdFor({ executionTarget: "runpod" });
		expect(held).toMatchObject({
			key: "runpod:main",
			until: Date.UTC(2027, 1, 1),
		});
		expect(held?.reason).toContain("$110.00 of $100.00");
		// A task that declares the account as a resource is held too.
		expect(
			await h.svc.holdFor({ requiresResources: ["runpod:main"] }),
		).not.toBeNull();
		// Tasks without that resource are untouched.
		expect(await h.svc.holdFor({ executionTarget: "local" })).toBeNull();
		expect(await h.svc.holdFor({ requiresResources: ["other"] })).toBeNull();

		// The live pod stops; the local run does not.
		expect(h.stops).toEqual(["POD-1"]);

		// Re-evaluating (ticks, restarts) repeats nothing.
		await h.svc.evaluate();
		await h.svc.evaluate();
		expect(await h.eventsOf("budget.exhausted")).toHaveLength(1);
		expect(await h.budgetItems()).toHaveLength(1);
		const [item] = await h.budgetItems();
		expect(item).toMatchObject({
			kind: "budget",
			severity: "attention",
			title: "budget exhausted: runpod:main",
		});
		// The stop is sent once, however often the budget is re-evaluated.
		expect(h.stops).toEqual(["POD-1"]);
	});

	test("warnAt fires budget.threshold once per window", async () => {
		const h = await harness(RUNPOD);
		await h.spend("runpod:main", 85);
		await h.svc.evaluate();
		await h.svc.evaluate();
		const t = await h.eventsOf("budget.threshold");
		expect(t).toHaveLength(1);
		expect(t[0]?.payload).toMatchObject({
			key: "runpod:main",
			kind: "resource",
			unit: "usd",
			used: 85,
			limit: 100,
		});
		expect(await h.eventsOf("budget.exhausted")).toHaveLength(0);
		expect(await h.svc.holdFor({ executionTarget: "runpod" })).toBeNull();
	});

	test("the window rolling over restores: event, hold lifted, inbox item gone", async () => {
		const h = await harness(RUNPOD);
		await h.spend("runpod:main", 120);
		await h.svc.evaluate();
		expect(await h.budgetItems()).toHaveLength(1);

		h.u.clock.t = Date.UTC(2027, 1, 1, 0, 1);
		await h.svc.evaluate();
		const restored = await h.eventsOf("budget.restored");
		expect(restored).toHaveLength(1);
		expect(restored[0]?.payload).toMatchObject({
			key: "runpod:main",
			reason: "window_reset",
		});
		expect(await h.svc.holdFor({ executionTarget: "runpod" })).toBeNull();
		expect(await h.budgetItems()).toHaveLength(0);
		// And the new window starts from zero: a fresh crossing announces again.
		await h.spend("runpod:main", 130);
		await h.svc.evaluate();
		expect(await h.eventsOf("budget.exhausted")).toHaveLength(2);
		expect(await h.budgetItems()).toHaveLength(1);
	});

	test("raising the limit restores with reason limit_raised", async () => {
		const h = await harness(RUNPOD);
		await h.spend("runpod:main", 120);
		await h.svc.evaluate();
		await saveConfig(
			{
				projects: [
					{
						name: "unit",
						root: h.u.root,
						budgets: {
							resources: { "runpod:main": { window: "month", limitUsd: 500 } },
						},
					},
				],
			},
			h.home,
		);
		await h.svc.evaluate();
		const restored = await h.eventsOf("budget.restored");
		expect(restored).toHaveLength(1);
		expect(restored[0]?.payload).toMatchObject({ reason: "limit_raised" });
		expect(await h.svc.holdFor({ executionTarget: "runpod" })).toBeNull();
	});

	test("finish_turn stops a live run only at a turn boundary", async () => {
		const h = await harness({
			resources: {
				"host:box": {
					window: "day",
					limitUsd: 1,
					liveRunPolicy: "finish_turn",
				},
			},
		});
		await h.liveRun("SSH-1", { executionTarget: "ssh", hostId: "box" });
		await h.u.registry.setActivity("SSH-1", "working", {
			pendingApprovals: [],
		} as never);
		await h.spend("host:box", 2);
		await h.svc.evaluate();
		expect(h.stops).toEqual([]);
		await h.u.registry.setActivity("SSH-1", "idle", {
			pendingApprovals: [],
		} as never);
		await h.svc.evaluate();
		expect(h.stops).toEqual(["SSH-1"]);
	});

	test("a machine budget sums every project ledger", async () => {
		const h = await harness(
			{},
			{
				machine: {
					resources: { "runpod:main": { window: "month", limitUsd: 100 } },
				},
			},
		);
		// A second project's ledger.
		const other = await openProjectDb(join(h.u.root, "other-mfw"));
		const svc = new BudgetService({
			handle: h.u.handle,
			bus: h.u.bus,
			log: silentLogger(),
			mfwHome: h.home,
			project: "unit",
			holds: h.holds,
			registry: h.u.registry,
			stopRun: async () => {},
			ledgers: () => [h.u.handle, other],
			now: () => h.u.clock.t,
			minIntervalMs: 0,
		});
		await h.spend("runpod:main", 70);
		await recordSpend(other.db, {
			kind: "resource",
			accountKey: "runpod:main",
			source: "runpod_billing",
			usd: 40,
			ts: new Date(h.u.clock.t),
		});
		await svc.evaluate();
		expect(await svc.holdFor({ executionTarget: "runpod" })).not.toBeNull();
		other.close();
	});
});

describe("agent budgets (P5b)", () => {
	const CLAUDE_DAY: StoredBudgets = {
		agents: { "claude-cli": { window: "day", limitTokens: 1000 } },
	};
	const settings: RoutingSettings = {
		provider: { id: "claude-cli", type: "claude-cli" },
		model: "sonnet",
		reasoningEffort: "medium",
		routing: { fallbacks: { default: [{ provider: "codex-cli" }] } },
	};

	async function exhaust(h: Awaited<ReturnType<typeof harness>>) {
		await recordSpend(h.u.handle.db, {
			kind: "agent",
			accountKey: "claude-cli",
			source: "run_usage",
			runId: "R-1",
			tokensIn: 900,
			tokensOut: 200,
			ts: new Date(h.u.clock.t),
		});
		await h.svc.evaluate();
	}

	test("exhaustion places a budget provider hold until the window resets, then lifts it", async () => {
		const h = await harness(CLAUDE_DAY);
		await exhaust(h);
		const active = await h.holds.active();
		expect(active["claude-cli"]).toMatchObject({
			reason: "budget",
			until: Date.UTC(2027, 0, 21),
		});
		// An agent budget raises no resource hold and no inbox item.
		expect(await h.budgetItems()).toHaveLength(0);
		expect(await h.eventsOf("budget.exhausted")).toHaveLength(1);

		h.u.clock.t = Date.UTC(2027, 0, 21, 0, 5);
		await h.svc.evaluate();
		expect((await h.holds.active())["claude-cli"]).toBeUndefined();
		expect((await h.eventsOf("budget.restored"))[0]?.payload).toMatchObject({
			reason: "window_reset",
		});
	});

	test("lifting a budget never clears a rate-limit hold on the same account", async () => {
		const h = await harness(CLAUDE_DAY);
		await exhaust(h);
		await h.holds.hold("claude-cli", {
			until: Date.UTC(2027, 0, 21, 6),
			reason: "rate limited",
		});
		h.u.clock.t = Date.UTC(2027, 0, 21, 0, 5);
		await h.svc.evaluate();
		expect((await h.holds.active())["claude-cli"]).toMatchObject({
			reason: "rate limited",
		});
	});

	test("routeRun skips a budget-held account for a project route and never overrides a pinned one", async () => {
		const h = await harness(CLAUDE_DAY);
		await exhaust(h);
		const held = await h.holds.snapshot();

		const project = routeRun({
			kind: "task",
			settings,
			task: { provider: null, model: null, modelTier: null },
			held,
		});
		expect(project).toMatchObject({
			provider: "codex-cli",
			reason: "fallback",
		});

		// A human pinned this task to Claude: it waits, it is not rerouted.
		const pinned = routeRun({
			kind: "task",
			settings,
			task: { provider: "claude-cli", model: null, modelTier: null },
			held,
		});
		expect(pinned.provider).toBe("claude-cli");
		expect(pinned.held).toMatchObject({ key: "claude-cli", reason: "budget" });
	});

	test("the brain's next turn runs on the next route and records a rollover", async () => {
		const h = await harness(CLAUDE_DAY);
		const { runtime } = h.u;
		(
			runtime as unknown as {
				deps: { config: () => unknown; engine: { routeBrain: unknown } };
			}
		).deps.config = () => ({
			routes: [{ provider: "claude-cli" }, { provider: "codex-cli" }],
			heartbeatMin: 100_000,
			rolloverTokens: 120_000,
			turnTimeoutMs: 600_000,
			maxTurnsPerHour: 20,
			maxTurnsPerDay: 100,
			failureLimit: 3,
		});
		const engine = (
			runtime as unknown as {
				deps: {
					engine: {
						routeBrain: (t: { provider: string; model?: string }) => unknown;
					};
				};
			}
		).deps.engine;
		engine.routeBrain = async (t: { provider: string; model?: string }) => {
			const hold = (await h.holds.active())[t.provider];
			const held = hold
				? { key: t.provider, until: hold.until, reason: hold.reason }
				: null;
			return {
				route: {
					provider: t.provider,
					model: t.model ?? "m",
					effort: "medium",
					endpoint: null,
					candidates: [],
					held,
				},
				held,
			};
		};
		await runtime.tick();
		await h.u.human("first");
		expect((await runtime.tick()).state).toBe("started");
		const providerOf = async (i: number) =>
			(await h.u.registry.get(h.u.launched[i]?.runId ?? ""))?.providerId;
		expect(await providerOf(0)).toBe("claude-cli");
		await h.u.endRun(h.u.launched[0]?.runId ?? "");
		await runtime.tick();

		await exhaust(h);
		h.u.advance(60_000);
		await h.u.human("second");
		expect((await runtime.tick()).state).toBe("started");
		expect(await providerOf(1)).toBe("codex-cli");
		expect(await h.eventsOf("brain.rollover")).toHaveLength(1);
	});
});

describe("brain budget", () => {
	test("exhaustion pauses the brain once and the window reset resumes it", async () => {
		const h = await harness({
			brain: { window: "day", limitUsd: 1 },
		});
		const calls: boolean[] = [];
		const svc = new BudgetService({
			handle: h.u.handle,
			bus: h.u.bus,
			log: silentLogger(),
			mfwHome: h.home,
			project: "unit",
			stored: { brain: { window: "day", limitUsd: 1 } },
			holds: h.holds,
			registry: h.u.registry,
			stopRun: async () => {},
			pauseBrain: async (p) => {
				calls.push(p);
			},
			now: () => h.u.clock.t,
			minIntervalMs: 0,
		});
		await recordSpend(h.u.handle.db, {
			kind: "brain",
			accountKey: "claude-cli",
			source: "brain_usage",
			runId: "B-1",
			usd: 2,
			ts: new Date(h.u.clock.t),
		});
		await svc.evaluate();
		await svc.evaluate();
		expect(calls).toEqual([true]);
		// an exhausted brain budget is visible to a person, not just a paused session
		expect(await svc.exhaustedForInbox()).toMatchObject([
			{ key: "brain", kind: "brain" },
		]);
		h.u.clock.t = Date.UTC(2027, 0, 21, 0, 1);
		await svc.evaluate();
		expect(calls).toEqual([true, false]);
	});

	test("removing an exhausted brain budget resumes the brain", async () => {
		const h = await harness({ brain: { window: "day", limitUsd: 1 } });
		const calls: boolean[] = [];
		const svc = new BudgetService({
			handle: h.u.handle,
			bus: h.u.bus,
			log: silentLogger(),
			mfwHome: h.home,
			project: "unit",
			stored: { brain: { window: "day", limitUsd: 1 } },
			holds: h.holds,
			registry: h.u.registry,
			stopRun: async () => {},
			pauseBrain: async (p) => {
				calls.push(p);
			},
			now: () => h.u.clock.t,
			minIntervalMs: 0,
		});
		await recordSpend(h.u.handle.db, {
			kind: "brain",
			accountKey: "claude-cli",
			source: "brain_usage",
			runId: "B-1",
			usd: 2,
			ts: new Date(h.u.clock.t),
		});
		await svc.evaluate();
		expect(calls).toEqual([true]);
		await saveConfig({ projects: [{ name: "unit", root: h.u.root }] }, h.home);
		await svc.evaluate();
		expect(calls).toEqual([true, false]);
	});
});

describe("config and API surface", () => {
	test("set writes the project entry, list reports spend against the limit, null removes", async () => {
		const h = await harness({});
		await saveConfig({ projects: [{ name: "unit", root: h.u.root }] }, h.home);
		await h.spend("runpod:main", 25);
		const after = await h.svc.set({
			scope: "project",
			kind: "resource",
			key: "runpod:main",
			entry: { window: "month", limitUsd: 100, warnAt: 0.5 },
		});
		expect(after).toHaveLength(1);
		expect(after[0]).toMatchObject({
			id: "resource:runpod:main",
			scope: "project",
			unit: "usd",
			used: 25,
			limit: 100,
			fraction: 0.25,
			phase: "ok",
			windowResetsAt: Date.UTC(2027, 1, 1),
		});
		expect(await h.svc.get("resource:runpod:main")).toMatchObject({
			limit: 100,
		});
		const removed = await h.svc.set({
			scope: "project",
			kind: "resource",
			key: "runpod:main",
			entry: null,
		});
		expect(removed).toHaveLength(0);
	});

	test("an entry with two limit units is refused", async () => {
		const h = await harness({});
		await saveConfig({ projects: [{ name: "unit", root: h.u.root }] }, h.home);
		await expect(
			h.svc.set({
				scope: "project",
				kind: "agent",
				key: "claude-cli",
				entry: { window: "day", limitUsd: 1, limitTokens: 10 },
			}),
		).rejects.toThrow();
	});
});

describe("through the daemon", () => {
	let fx: BrainFixture | undefined;
	afterEach(async () => {
		await fx?.cleanup();
		fx = undefined;
	});

	const heldEvents = async (f: BrainFixture, taskId: string) =>
		(
			await f.svc.handle.db
				.select()
				.from(events)
				.where(eq(events.type, "task.held_for_resource"))
		).filter((e) => e.taskId === taskId);

	test("a depending task is held with task.held_for_resource, an independent one starts, a manual start is refused, one inbox item", async () => {
		fx = await brainFixture({
			brain: STUB_BRAIN,
			project: {
				budgets: {
					resources: { "runpod:main": { window: "month", limitUsd: 100 } },
				},
			},
		});
		const { svc } = fx;
		const pod = await svc.tasks.create({
			title: "needs a pod",
			body: "x",
			requiresResources: ["runpod:main"],
			status: "ready",
		});
		const plain = await svc.tasks.create({
			title: "plain work",
			body: "x",
			status: "ready",
		});
		// Both were spawned by the brain before the budget ran out.
		await brainSpawn(svc, pod.id);
		await brainSpawn(svc, plain.id);
		await recordSpend(svc.handle.db, {
			kind: "resource",
			accountKey: "runpod:main",
			source: "runpod_billing",
			usd: 150,
		});
		await svc.budgets.evaluate();

		const stats = await svc.scheduler.tick();
		expect(stats.heldForResource).toContain(pod.id);
		expect(stats.started).toContain(plain.id);
		expect(stats.started).not.toContain(pod.id);

		const held = await heldEvents(fx, pod.id);
		expect(held).toHaveLength(1);
		expect(held[0]?.payload).toMatchObject({
			code: "budget_exhausted",
			waitingFor: ["runpod:main"],
		});

		// The scheduler never even asks for admission: nothing is created, no
		// claim is taken and no host capacity is looked at for the held task.
		expect(
			(
				await svc.handle.db
					.select()
					.from(dispatchAdmissions)
					.where(eq(dispatchAdmissions.taskId, pod.id))
			).length,
		).toBe(0);

		// A human pressing Run does not get around a spent budget.
		await expect(
			svc.admission.startTask(pod.id, { actor: "human" }),
		).rejects.toMatchObject({ code: "budget_exhausted" });

		// Held again next tick, not announced again.
		const announced = (await heldEvents(fx, pod.id)).length;
		await svc.scheduler.tick();
		await svc.scheduler.tick();
		expect(await heldEvents(fx, pod.id)).toHaveLength(announced);

		const items = (await svc.inbox.list()).filter((i) => i.kind === "budget");
		expect(items).toHaveLength(1);
		expect(items[0]?.fix).toContain("Settings");
	});

	test("the brain's spawn for a budget-held resource is rejected with a typed fix, others pass", async () => {
		fx = await brainFixture({
			brain: STUB_BRAIN,
			project: {
				budgets: {
					resources: { "runpod:main": { window: "month", limitUsd: 100 } },
				},
			},
		});
		const { svc } = fx;
		const pod = await svc.tasks.create({
			title: "needs a pod",
			body: "x",
			requiresResources: ["runpod:main"],
			status: "ready",
		});
		const plain = await svc.tasks.create({
			title: "plain",
			body: "x",
			status: "ready",
		});
		const why = { rationale: "frontier" };
		await recordSpend(svc.handle.db, {
			kind: "resource",
			accountKey: "runpod:main",
			source: "runpod_billing",
			usd: 150,
		});
		await svc.budgets.evaluate();
		const held = await svc.brainRuntime.actions.check("spawn", {
			...why,
			taskId: pod.id,
			role: "implement",
		});
		expect(held.ok).toBe(false);
		if (!held.ok) {
			expect(held.rejection.code).toBe("budget_exhausted");
			expect(held.rejection.fix?.text).toContain("runpod:main");
		}
		const free = await svc.brainRuntime.actions.check("spawn", {
			...why,
			taskId: plain.id,
			role: "implement",
		});
		expect(free.ok).toBe(true);
	});

	test("set_budget lowers within the configured ceiling and refuses above it, another unit or an unknown budget", async () => {
		fx = await brainFixture({
			brain: STUB_BRAIN,
			project: {
				budgets: {
					resources: { "runpod:main": { window: "month", limitUsd: 100 } },
				},
			},
		});
		const { svc } = fx;
		const check = (args: Record<string, unknown>) =>
			svc.brainRuntime.actions.check("set_budget", {
				rationale: "reserve for reviews",
				...args,
			});
		expect((await check({ budget: "runpod:main", limitUsd: 60 })).ok).toBe(
			true,
		);
		const codeOf = async (args: Record<string, unknown>) => {
			const r = await check(args);
			return r.ok ? "ok" : r.rejection.code;
		};
		expect(await codeOf({ budget: "runpod:main", limitUsd: 150 })).toBe(
			"above_ceiling",
		);
		expect(await codeOf({ budget: "runpod:main", limitTokens: 10 })).toBe(
			"unit_mismatch",
		);
		expect(
			await codeOf({ budget: "runpod:main", limitUsd: 5, window: "day" }),
		).toBe("window_fixed");
		expect(await codeOf({ budget: "nope", limitUsd: 5 })).toBe(
			"ceiling_unknown",
		);

		// Applied: the effective limit drops and spend past it exhausts.
		await svc.budgets.applyBrainLimit({ budget: "runpod:main", limitUsd: 60 });
		await recordSpend(svc.handle.db, {
			kind: "resource",
			accountKey: "runpod:main",
			source: "runpod_billing",
			usd: 70,
		});
		await svc.budgets.evaluate();
		const [b] = await svc.budgets.list();
		expect(b).toMatchObject({ limit: 60, phase: "exhausted" });
		// The human ceiling is untouched, and the brain cannot go back above it.
		expect(
			await svc.budgets.checkBrainLimit({
				budget: "runpod:main",
				limitUsd: 100,
			}),
		).toMatchObject({ ok: true, ceiling: 100 });
	});

	test("a live run on an exhausted resource is stopped for real", async () => {
		fx = await brainFixture({
			brain: STUB_BRAIN,
			project: {
				budgets: {
					resources: {
						gpu: { window: "day", limitUsd: 1, liveRunPolicy: "stop" },
					},
				},
			},
		});
		const { svc } = fx;
		await svc.resources.register({ id: "gpu", maxConcurrent: 1 });
		await fx.plan("hold");
		const t = await svc.tasks.create({
			title: "uses the gpu",
			body: "x",
			requiresResources: ["gpu"],
			status: "ready",
		});
		await brainSpawn(svc, t.id);
		const stats = await svc.scheduler.tick();
		expect(stats.started).toContain(t.id);
		const [run] = await svc.registry.list({ taskId: t.id });
		const runId = run?.id as string;
		await recordSpend(svc.handle.db, {
			kind: "resource",
			accountKey: "gpu",
			source: "runpod_billing",
			usd: 5,
		});
		await svc.budgets.evaluate();
		await fx.until(
			async () => {
				const r = await svc.registry.get(runId);
				return !!r && !["starting", "running"].includes(r.state);
			},
			{ what: "the run to be stopped" },
		);
		await fx.release();
	});
});
