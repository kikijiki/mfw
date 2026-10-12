import { describe, expect, test } from "bun:test";
import {
	type BudgetRowLike,
	barPercent,
	blankDraft,
	budgetTone,
	consequenceOf,
	draftOf,
	formatAmount,
	spendReading,
	validateBudgetDraft,
} from "./budgetsDraft";

const row = (over: Partial<BudgetRowLike> = {}): BudgetRowLike => ({
	kind: "resource",
	scope: "project",
	key: "runpod:main",
	window: "month",
	unit: "usd",
	limit: 100,
	warnAt: 0.8,
	liveRunPolicy: "stop",
	used: 110,
	fraction: 1.1,
	phase: "exhausted",
	windowResetsAt: 0,
	...over,
});

describe("budget draft validation", () => {
	test("a resource draft becomes a set input with its unit field and policy", () => {
		const d = {
			...blankDraft("resource"),
			key: " runpod:main ",
			limit: "200",
			warnPercent: "80",
		};
		expect(validateBudgetDraft(d)).toEqual({
			scope: "project",
			kind: "resource",
			key: "runpod:main",
			entry: {
				window: "month",
				limitUsd: 200,
				warnAt: 0.8,
				liveRunPolicy: "stop",
			},
		});
	});

	test("an agent draft in tokens has no live-run policy; an empty warn is omitted", () => {
		const out = validateBudgetDraft({
			...blankDraft("agent"),
			key: "claude-cli",
			window: "5h",
			limit: "40000000",
			warnPercent: "",
		});
		expect(out.entry).toEqual({ window: "5h", limitTokens: 40_000_000 });
	});

	test("the brain budget is keyed brain whatever was typed", () => {
		const out = validateBudgetDraft({
			...blankDraft("brain"),
			key: "ignored",
			window: "day",
			limit: "10",
		});
		expect(out.key).toBe("brain");
	});

	test.each([
		[{ key: "" }, /Resource must be/],
		[{ key: "has space" }, /Resource must be/],
		[{ window: "fortnight" }, /Window must be/],
		[{ limit: "0" }, /greater than zero/],
		[{ limit: "abc" }, /greater than zero/],
		[{ warnPercent: "150" }, /between 1 and 100/],
		[{ unit: "tokens" as const, limit: "1.5" }, /whole number/],
	])("refuses %j", (over, message) => {
		expect(() =>
			validateBudgetDraft({
				...blankDraft("resource"),
				key: "runpod:main",
				limit: "10",
				...over,
			}),
		).toThrow(message);
	});

	test("editing a row round-trips through the draft", () => {
		const r = row({ limit: 250, warnAt: 0.5, liveRunPolicy: "finish_turn" });
		const out = validateBudgetDraft(draftOf(r));
		expect(out.entry).toMatchObject({
			limitUsd: 250,
			warnAt: 0.5,
			liveRunPolicy: "finish_turn",
		});
	});
});

describe("budget readings", () => {
	test("spend against limit with a percentage", () => {
		expect(spendReading(row())).toBe("$110.00 of $100.00 (110%)");
		expect(
			spendReading(
				row({
					unit: "tokens",
					used: 1_500_000,
					limit: 40_000_000,
					fraction: 0.04,
				}),
			),
		).toBe("1.5M tokens of 40.0M tokens (4%)");
		expect(formatAmount(2.25, "slot_hours")).toBe("2.3 slot-h");
	});

	test("tone follows the phase and the bar clamps", () => {
		expect(budgetTone({ phase: "exhausted" })).toBe("critical");
		expect(budgetTone({ phase: "warned" })).toBe("warn");
		expect(budgetTone({ phase: "ok" })).toBe("ok");
		expect(barPercent({ fraction: 1.7 })).toBe(100);
		expect(barPercent({ fraction: 0.256 })).toBe(26);
	});

	test("each kind says what exhaustion does", () => {
		expect(consequenceOf({ kind: "agent", liveRunPolicy: "stop" })).toMatch(
			/held until the window resets/,
		);
		expect(consequenceOf({ kind: "resource", liveRunPolicy: "stop" })).toMatch(
			/live runs are stopped/,
		);
		expect(
			consequenceOf({ kind: "resource", liveRunPolicy: "finish_turn" }),
		).toMatch(/after their turn/);
		expect(consequenceOf({ kind: "brain", liveRunPolicy: "stop" })).toMatch(
			/paused/,
		);
	});
});
