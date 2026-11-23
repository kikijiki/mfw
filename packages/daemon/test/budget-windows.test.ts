import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectDb, type ProjectDbHandle } from "@mfw/db/client";
import { recordSpend } from "@mfw/db/spend";
import {
	type BudgetWindowRef,
	BudgetWindows,
} from "../src/resources/budget-windows.ts";
import {
	openResourceStore,
	type ResourceStore,
} from "../src/resources/store.ts";

const DAY = Date.UTC(2027, 0, 20);
const bounds = { start: DAY, end: DAY + 86_400_000 };
const budget = (over: Partial<BudgetWindowRef> = {}): BudgetWindowRef => ({
	id: "resource:runpod:main",
	key: "runpod:main",
	kind: "resource",
	scope: "machine",
	window: "day",
	unit: "usd",
	limit: 100,
	...over,
});

describe("budget usage in core windows", () => {
	let home: string;
	let store: ResourceStore;
	let windows: BudgetWindows;
	let alpha: ProjectDbHandle;
	let beta: ProjectDbHandle;

	const spend = (
		handle: ProjectDbHandle,
		usd: number,
		ts = DAY + 1_000,
		key = "runpod:main",
	) =>
		recordSpend(handle.db, {
			kind: "resource",
			accountKey: key,
			source: "runpod_billing",
			usd,
			ts: new Date(ts),
		});

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "mfw-budget-windows-"));
		store = await openResourceStore(home, { now: () => DAY + 2_000 });
		windows = new BudgetWindows(store);
		alpha = await openProjectDb(join(home, "alpha", ".mfw"));
		beta = await openProjectDb(join(home, "beta", ".mfw"));
	});

	afterEach(async () => {
		alpha.close();
		beta.close();
		store.close();
		await rm(home, { recursive: true, force: true });
	});

	test("a machine budget totals every project once, however often it runs", async () => {
		await spend(alpha, 30);
		await spend(beta, 12.5);
		for (let i = 0; i < 3; i++) {
			expect(
				await windows.measure(budget(), bounds, [alpha, beta], "alpha"),
			).toBeCloseTo(42.5, 6);
		}
	});

	test("spend already counted survives its project being detached", async () => {
		await spend(alpha, 30);
		await spend(beta, 10);
		await windows.measure(budget(), bounds, [alpha, beta], "alpha");
		expect(
			await windows.measure(budget(), bounds, [alpha], "alpha"),
		).toBeCloseTo(40, 6);
	});

	test("rows outside the window and for other accounts do not count", async () => {
		await spend(alpha, 5, DAY - 1);
		await spend(alpha, 7, bounds.end);
		await spend(alpha, 9, DAY + 1, "runpod:other");
		await spend(alpha, 2);
		expect(
			await windows.measure(budget(), bounds, [alpha], "alpha"),
		).toBeCloseTo(2, 6);
		expect(
			await windows.measure(
				budget({ id: "resource:runpod:*", key: "runpod:*" }),
				bounds,
				[alpha],
				"alpha",
			),
		).toBeCloseTo(11, 6);
	});

	test("a corrected spend row replaces its earlier amount", async () => {
		const usage = (usd: number) =>
			recordSpend(
				alpha.db,
				{
					kind: "agent",
					accountKey: "runpod:main",
					source: "runpod_billing",
					runId: "run-a",
					usd,
					ts: new Date(DAY + 1_000),
				},
				"replace",
			);
		await usage(4);
		expect(
			await windows.measure(budget(), bounds, [alpha], "alpha"),
		).toBeCloseTo(4, 6);
		await usage(6);
		expect(
			await windows.measure(budget(), bounds, [alpha], "alpha"),
		).toBeCloseTo(6, 6);
	});

	test("large token totals stay exact", async () => {
		const tokens = 12_345_678_901;
		await recordSpend(alpha.db, {
			kind: "resource",
			accountKey: "runpod:main",
			source: "runpod_billing",
			tokensIn: tokens,
			tokensOut: 99,
			ts: new Date(DAY + 1_000),
		});
		expect(
			await windows.measure(
				budget({ unit: "tokens", limit: 50_000_000_000 }),
				bounds,
				[alpha],
				"alpha",
			),
		).toBe(tokens + 99);
	});

	test("an absurd host figure exhausts the budget instead of failing it", async () => {
		await recordSpend(alpha.db, {
			kind: "resource",
			accountKey: "runpod:main",
			source: "runpod_billing",
			usd: 1e18,
			ts: new Date(DAY + 1_000),
		});
		expect(
			await windows.measure(budget(), bounds, [alpha], "alpha"),
		).toBeGreaterThan(100);
	});

	test("reported spend is shown but never enters the core's ledger", async () => {
		await recordSpend(alpha.db, {
			kind: "agent",
			accountKey: "runpod:main",
			source: "run_usage",
			runId: "forged",
			usd: 1e18,
			tokensIn: 1e15,
			ts: new Date(DAY + 1_000),
		});
		expect(await windows.measure(budget(), bounds, [alpha], "alpha")).toBe(0);
		expect(
			await windows.measure(budget(), bounds, [alpha], "alpha", "reported"),
		).toBe(1e18);
		expect(await store.ledger()).toEqual([]);
	});

	test("the same budget in two projects counts separately", async () => {
		const scoped = budget({ scope: "project" });
		await spend(alpha, 3);
		await spend(beta, 8);
		expect(await windows.measure(scoped, bounds, [alpha], "alpha")).toBeCloseTo(
			3,
			6,
		);
		expect(await windows.measure(scoped, bounds, [beta], "beta")).toBeCloseTo(
			8,
			6,
		);
	});
});
