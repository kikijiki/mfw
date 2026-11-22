import { describe, expect, test } from "bun:test";
import {
	type AdmissionSnapshot,
	type DimensionState,
	decide,
	evaluateClaims,
} from "../src/resources/admission.ts";
import { fromStored, toStored } from "../src/resources/amounts.ts";
import type { HoldReason } from "../src/resources/types.ts";
import { windowStart } from "../src/resources/windows.ts";

function dim(partial: Partial<DimensionState> = {}): DimensionState {
	return {
		kind: "quantity",
		capacity: 10,
		used: 0,
		settled: 0,
		quotas: new Map(),
		...partial,
	};
}

function snap(
	pools: Record<
		string,
		{ holds?: HoldReason[]; dims: Record<string, DimensionState> }
	>,
): AdmissionSnapshot {
	return new Map(
		Object.entries(pools).map(([id, p]) => [
			id,
			{ holds: p.holds ?? [], dimensions: new Map(Object.entries(p.dims)) },
		]),
	);
}

const claim = (poolId: string, amount = 1, dimension = "d") => ({
	poolId,
	dimension,
	amount,
});

describe("evaluateClaims", () => {
	test("an unknown pool is parked, never admitted", () => {
		const v = evaluateClaims(snap({}), [claim("a.b")], [], 0);
		expect(v.status).toBe("parked");
		expect(v.blockers[0]?.code).toBe("unknown-pool");
	});

	test("capacity in use blocks, a claim that can never fit parks", () => {
		const s = snap({ "a.b": { dims: { d: dim({ used: 8 }) } } });
		expect(evaluateClaims(s, [claim("a.b", 3)], [], 0).status).toBe("blocked");
		expect(evaluateClaims(s, [claim("a.b", 11)], [], 0).status).toBe("parked");
		expect(evaluateClaims(s, [claim("a.b", 2)], [], 0).status).toBe(
			"grantable",
		);
	});

	test("a window blocked only by reservations waits; settled spend parks", () => {
		const reserved = snap({
			"a.b": { dims: { d: dim({ kind: "window", used: 9, settled: 2 }) } },
		});
		expect(evaluateClaims(reserved, [claim("a.b", 5)], [], 0).status).toBe(
			"blocked",
		);
		const spent = snap({
			"a.b": { dims: { d: dim({ kind: "window", used: 9, settled: 9 }) } },
		});
		expect(evaluateClaims(spent, [claim("a.b", 5)], [], 0).status).toBe(
			"parked",
		);
	});

	test("a grant must fit at every quota level, and siblings may overcommit", () => {
		const quotas = new Map([
			["project:p", { limit: 6, used: 5, settled: 0 }],
			["project:q", { limit: 6, used: 0, settled: 0 }],
		]);
		const s = snap({ "a.b": { dims: { d: dim({ used: 5, quotas }) } } });
		const p = [{ scope: "project", name: "p" }];
		const q = [{ scope: "project", name: "q" }];
		expect(evaluateClaims(s, [claim("a.b", 2)], p, 0).blockers[0]?.detail).toBe(
			"project:p",
		);
		expect(evaluateClaims(s, [claim("a.b", 2)], q, 0).status).toBe("grantable");
	});

	test("an unknown meter admits; a full one parks until its reset", () => {
		const meter = (
			meterFraction: number | null,
			meterResetsAt: number | null,
		) =>
			snap({
				"a.b": {
					dims: { m: dim({ kind: "meter", meterFraction, meterResetsAt }) },
				},
			});
		const c = [{ poolId: "a.b", dimension: "m" }];
		expect(evaluateClaims(meter(null, null), c, [], 10).status).toBe(
			"grantable",
		);
		expect(evaluateClaims(meter(1, 20), c, [], 10).status).toBe("parked");
		expect(evaluateClaims(meter(1, 5), c, [], 10).status).toBe("grantable");
	});

	test("named units pick free identities and refuse unknown ones", () => {
		const s = snap({
			"a.b": {
				dims: {
					d: dim({
						kind: "slot",
						capacity: 2,
						used: 1,
						units: ["u0", "u1"],
						freeUnits: ["u1"],
					}),
				},
			},
		});
		const free = evaluateClaims(s, [claim("a.b", 1)], [], 0);
		expect(free.units.get("a.b\0d")).toEqual(["u1"]);
		const taken = [{ ...claim("a.b", 1), unit: "u0" }];
		expect(evaluateClaims(s, taken, [], 0).status).toBe("blocked");
		const unknown = [{ ...claim("a.b", 1), unit: "u9" }];
		expect(evaluateClaims(s, unknown, [], 0).status).toBe("parked");
	});
});

describe("decide", () => {
	const waiter = (
		id: string,
		sequence: number,
		claims: ReturnType<typeof claim>[],
	) => ({
		id,
		sequence,
		claims,
		scopes: [],
	});

	test("nothing backfills past an older grantable waiter", () => {
		const s = snap({ "a.b": { dims: { d: dim({ used: 5 }) } } });
		const big = waiter("big", 1, [claim("a.b", 8)]);
		const small = waiter("small", 2, [claim("a.b", 1)]);
		const v = decide(s, [big, small], small, 0);
		expect(v.status).toBe("blocked");
		expect(v.blockers[0]).toMatchObject({ code: "fifo", detail: "big" });
	});

	test("a waiter on a held pool parks and stops blocking the shared pool", () => {
		const s = snap({
			"local.cpu": { dims: { d: dim() } },
			"openrouter.main": { holds: ["budget"], dims: { d: dim() } },
		});
		const parked = waiter("parked", 1, [
			claim("local.cpu"),
			claim("openrouter.main"),
		]);
		const next = waiter("next", 2, [claim("local.cpu")]);
		expect(decide(s, [parked, next], parked, 0).status).toBe("parked");
		expect(decide(s, [parked, next], next, 0).status).toBe("grantable");
	});

	test("when the hold clears the parked waiter regains its position", () => {
		const s = snap({
			"local.cpu": { dims: { d: dim() } },
			"openrouter.main": { dims: { d: dim() } },
		});
		const first = waiter("first", 1, [
			claim("local.cpu"),
			claim("openrouter.main"),
		]);
		const next = waiter("next", 2, [claim("local.cpu")]);
		expect(decide(s, [first, next], first, 0).status).toBe("grantable");
		expect(decide(s, [first, next], next, 0).status).toBe("blocked");
	});

	test("sharing only a meter does not order two waiters", () => {
		const s = snap({
			"claude-cli.fleet": { dims: { m: dim({ kind: "meter" }) } },
			"local.a": { dims: { d: dim({ used: 10 }) } },
			"local.b": { dims: { d: dim() } },
		});
		const meter = { poolId: "claude-cli.fleet", dimension: "m", amount: 0 };
		const older = waiter("older", 1, [meter, claim("local.a")]);
		const younger = waiter("younger", 2, [meter, claim("local.b")]);
		expect(decide(s, [older, younger], younger, 0).status).toBe("grantable");
	});
});

describe("amounts", () => {
	test("stored amounts round up and never drift", () => {
		expect(toStored("window", 0.1)).toBe(100_000);
		expect(toStored("window", 0.0000001)).toBe(1);
		expect(fromStored("window", toStored("window", 4))).toBe(4);
		expect(toStored("slot", 2)).toBe(2);
	});

	test("invalid amounts are refused", () => {
		expect(() => toStored("slot", 1.5)).toThrow();
		expect(() => toStored("window", Number.NaN)).toThrow();
		expect(() => toStored("quantity", -1)).toThrow();
		expect(() => toStored("window", Number.MAX_VALUE)).toThrow();
	});
});

describe("windowStart", () => {
	const at = Date.UTC(2026, 10, 18, 15, 30); // Wednesday

	test("rolling", () => {
		expect(windowStart({ type: "rolling", seconds: 60 }, at)).toBe(at - 60_000);
	});

	test("calendar periods in a zone", () => {
		const tz = "Asia/Tokyo";
		expect(windowStart({ type: "calendar", period: "day", tz }, at)).toBe(
			Date.UTC(2026, 10, 18, 15),
		);
		expect(windowStart({ type: "calendar", period: "week", tz }, at)).toBe(
			Date.UTC(2026, 10, 15, 15),
		);
		expect(windowStart({ type: "calendar", period: "month", tz }, at)).toBe(
			Date.UTC(2026, 9, 31, 15),
		);
	});

	test("a day that starts inside a DST gap begins at its first instant", () => {
		// Havana skips 00:00-01:00 on 2026-03-08.
		const noon = Date.UTC(2026, 2, 8, 16);
		const start = windowStart(
			{ type: "calendar", period: "day", tz: "America/Havana" },
			noon,
		);
		expect(start).toBe(Date.UTC(2026, 2, 8, 5));
	});

	test("an unknown zone is refused", () => {
		expect(() =>
			windowStart({ type: "calendar", period: "day", tz: "Mars/Olympus" }, at),
		).toThrow();
	});
});
