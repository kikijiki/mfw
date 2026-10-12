import { describe, expect, test } from "bun:test";
import { watchdogPatch } from "./ProjectConfig";

const base = {
	idleMinutes: "5",
	wallMinutes: "45",
	maxTurns: "0",
	scopeMode: "kill" as const,
	scopeMaxFiles: "150",
	scopeOnFinish: true,
};

describe("watchdog settings patch", () => {
	test("nothing changed sends nothing, so the defaults keep applying", () => {
		expect(watchdogPatch(base, base)).toBeUndefined();
	});

	test("only the changed fields go on the wire, minutes become ms", () => {
		expect(
			watchdogPatch({ ...base, idleMinutes: "10", scopeMaxFiles: "60" }, base),
		).toEqual({ idleMs: 600_000, scope: { maxFiles: 60 } });
	});

	test("the finish check toggle maps to onFinish", () => {
		expect(
			watchdogPatch({ ...base, scopeOnFinish: false, scopeMode: "warn" }, base),
		).toEqual({ scope: { mode: "warn", onFinish: "off" } });
	});
});
