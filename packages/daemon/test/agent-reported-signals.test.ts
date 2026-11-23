import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { recordSpend } from "@mfw/db/spend";
import { AUTH_HOLD_REASON } from "../src/auth-failure.ts";
import { BudgetService } from "../src/budgets.ts";
import { StepRunner } from "../src/finalize/step-runner.ts";
import type { ProviderHoldStore } from "../src/provider-holds.ts";
import type { BudgetWindows } from "../src/resources/budget-windows.ts";
import { CLAUDE_WEEKLY_SOURCE } from "../src/usage/claude-weekly.ts";
import { UsageMonitor } from "../src/usage-monitor.ts";
import { openTestBudgetStores, openTestHolds } from "./support/host-ledger.ts";

/**
 * Security review P5b, M1: rate-limit, login and usage signals come from the
 * sandbox. One forged event must not stop the fleet or poison a hard budget.
 */

const YEAR_2100 = 4_102_444_800_000;
const HOUR = 3_600_000;

let home: string;
let store: ProviderHoldStore;

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "mfw-m1-"));
	store = await openTestHolds(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** The real hold step of the finalizer, for one run of one project. */
async function holdFrom(
	project: string,
	runId: string,
	classify: { resetsAt?: number; auth?: true },
) {
	const runner = Object.create(StepRunner.prototype) as {
		deps: unknown;
		holdRateLimit(built: unknown): Promise<unknown>;
	};
	runner.deps = { providerHolds: store, projectName: project };
	return runner.holdRateLimit({
		run: { id: runId, providerId: "claude-cli", routing: null },
		results: new Map([["classify", classify]]),
	});
}

const machineHold = async () => (await store.snapshot())("claude-cli");

describe("M1: forged rate-limit and login signals", () => {
	test("a forged reset in 2100 is clamped and stays in its project", async () => {
		await holdFrom("a", "r1", { resetsAt: YEAR_2100 });
		expect(await machineHold()).toBeNull();
		const own = (await store.forProject("a").snapshot())("claude-cli");
		expect(own).not.toBeNull();
		expect(own?.until).toBeLessThanOrEqual(Date.now() + HOUR);
		expect((await store.forProject("b").snapshot())("claude-cli")).toBeNull();
	});

	test("a forged login failure is not a 24-hour machine hold", async () => {
		await holdFrom("a", "r1", { auth: true });
		expect(await machineHold()).toBeNull();
		const own = (await store.forProject("a").snapshot())("claude-cli");
		expect(own?.reason).toBe(AUTH_HOLD_REASON);
		expect(own?.until).toBeLessThanOrEqual(Date.now() + HOUR);
	});

	test("more runs of one project never confirm a machine hold", async () => {
		for (const id of ["r1", "r2", "r3"]) {
			await holdFrom("a", id, { resetsAt: Date.now() + 5 * 60_000 });
		}
		expect(await machineHold()).toBeNull();
	});

	test("a second project's independent signal confirms it, still clamped", async () => {
		await holdFrom("a", "r1", { resetsAt: YEAR_2100 });
		await holdFrom("b", "r2", { resetsAt: YEAR_2100 });
		const hold = await machineHold();
		expect(hold).not.toBeNull();
		expect(hold?.until).toBeLessThanOrEqual(Date.now() + HOUR);
	});

	test("signals too far apart do not confirm each other", async () => {
		let t = 1_000_000;
		const clocked = await openTestHolds(home, () => t);
		await clocked.report("claude-cli", {
			project: "a",
			until: t + 60_000,
			reason: "x",
		});
		t += 16 * 60_000;
		const second = await clocked.report("claude-cli", {
			project: "b",
			until: t + 60_000,
			reason: "x",
		});
		expect(second.scope).toBe("project");
	});

	test.each([
		Number.NaN,
		Number.POSITIVE_INFINITY,
		-1,
		0,
	])("a nonsense reset (%p) still gets a short hold", async (until) => {
		const r = await store.report("claude-cli", {
			project: "a",
			until,
			reason: "x",
		});
		expect(r.until).toBeGreaterThan(Date.now());
		expect(r.until).toBeLessThanOrEqual(Date.now() + HOUR);
	});

	test("a weekly window seen only in agent events never places a hold", async () => {
		const placed: string[] = [];
		const monitor = new UsageMonitor({
			probes: [
				{
					provider: "claude-cli",
					name: "claude-cli",
					available: async () => true,
					run: async () => ({
						windows: [
							{
								label: "7d",
								usedPercent: 100,
								resetsAt: YEAR_2100,
								windowMinutes: 10_080,
								source: CLAUDE_WEEKLY_SOURCE,
							},
						],
					}),
				},
			],
			holds: {
				hold: async (key: string, hold: { until: number; reason: string }) => {
					placed.push(key);
					return { ...hold };
				},
				clear: async () => {},
				active: async () => ({}),
			},
		} as never);
		const seen = await monitor.refresh();
		// Positive control: the window was read, and is still shown.
		expect(seen[0]?.windows[0]?.usedPercent).toBe(100);
		expect(placed).toEqual([]);
	});
});

describe("M1: reported spend is display-only", () => {
	let handle: ProjectDbHandle;
	let windows: BudgetWindows;
	beforeEach(async () => {
		handle = await openProjectDb(join(home, "db"));
		({ windows } = await openTestBudgetStores(home));
	});
	afterEach(() => handle.close());

	const budgets = () =>
		new BudgetService({
			handle,
			bus: { publish: () => {} },
			log: { warn: () => {}, info: () => {} },
			mfwHome: home,
			project: "a",
			stored: {
				agents: { "claude-cli": { window: "day", limitUsd: 10 } },
				resources: { "runpod:x": { window: "day", limitUsd: 10 } },
			},
			holds: store,
			windows,
			registry: { list: async () => [] },
			stopRun: async () => {},
			ledgers: () => [handle],
			now: () => Date.now(),
			minIntervalMs: 0,
		} as never);

	test("forged usage cannot exhaust a budget, and is shown as reported", async () => {
		await recordSpend(handle.db, {
			kind: "agent",
			accountKey: "claude-cli",
			source: "run_usage",
			runId: "r1",
			usd: 1e9,
			tokensIn: 1e15,
		});
		const svc = budgets();
		await svc.evaluate();
		const [status] = (await svc.list()).filter((b) => b.key === "claude-cli");
		expect(status?.phase).toBe("ok");
		expect(status?.used).toBe(0);
		expect(status?.reported).toEqual({
			value: 1e9,
			provenance: "sandbox-reported",
		});
		expect(await machineHold()).toBeNull();
	});

	test("a host-observed charge still enforces the budget", async () => {
		await recordSpend(handle.db, {
			kind: "resource",
			accountKey: "runpod:x",
			source: "runpod_billing",
			usd: 11,
		});
		const svc = budgets();
		await svc.evaluate();
		const [status] = (await svc.list()).filter((b) => b.key === "runpod:x");
		expect(status?.phase).toBe("exhausted");
	});
});
