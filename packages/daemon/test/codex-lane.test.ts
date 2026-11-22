import { describe, expect, test } from "bun:test";
import {
	CodexLane,
	type CodexLoginOutput,
	codexConcurrencyLimit,
	codexHomeOf,
	codexSlotResourceId,
	parseCodexLoginStatus,
} from "../src/codex-lane.ts";
import type { HostSlotLedger } from "../src/host-service.ts";

const out = (stdout: string, exitCode = 0, stderr = ""): CodexLoginOutput => ({
	exitCode,
	stdout,
	stderr,
});

describe("parseCodexLoginStatus", () => {
	test("reads the mode from either stream", () => {
		expect(parseCodexLoginStatus(out("Logged in using ChatGPT\n"))).toBe(
			"chatgpt",
		);
		expect(parseCodexLoginStatus(out("", 0, "Logged in using ChatGPT\n"))).toBe(
			"chatgpt",
		);
		expect(
			parseCodexLoginStatus(out("Logged in using an API key - sk-***abcd\n")),
		).toBe("api-key");
		expect(parseCodexLoginStatus(out("Not logged in\n", 1))).toBe("none");
		expect(parseCodexLoginStatus(out("something new"))).toBe("unknown");
	});

	test("limits: one run unless the login is an API key", () => {
		expect(codexConcurrencyLimit("chatgpt")).toBe(1);
		expect(codexConcurrencyLimit("none")).toBe(1);
		expect(codexConcurrencyLimit("unknown")).toBe(1);
		expect(codexConcurrencyLimit("api-key")).toBeNull();
	});
});

describe("codex home", () => {
	test("CODEX_HOME wins, else ~/.codex", () => {
		expect(codexHomeOf({ CODEX_HOME: "/fleet/codex", HOME: "/h" })).toBe(
			"/fleet/codex",
		);
		expect(codexHomeOf({ HOME: "/h" })).toBe("/h/.codex");
	});

	test("the slot id is stable, per home, and never a path", () => {
		const a = codexSlotResourceId("/fleet/a");
		expect(a).toBe(codexSlotResourceId("/fleet/a"));
		expect(a).not.toBe(codexSlotResourceId("/fleet/b"));
		expect(a).toMatch(/^codex\.[0-9a-f]{12}\.slots$/);
	});
});

function fakeLedger() {
	const defs: Record<string, unknown>[] = [];
	const ledger: HostSlotLedger = {
		readModel: () => ({ definitions: defs }) as never,
		putDefinition: async (d) => {
			const i = defs.findIndex((x) => x.id === d.id);
			if (i >= 0) defs[i] = d as never;
			else defs.push(d as never);
			return d;
		},
	};
	return { ledger, defs };
}

describe("CodexLane", () => {
	test("a ChatGPT login holds a one-slot resource for its CODEX_HOME", async () => {
		const { ledger, defs } = fakeLedger();
		const seen: (string | undefined)[] = [];
		const lane = new CodexLane({
			ledger,
			env: () => ({ CODEX_HOME: "/fleet/codex" }),
			run: async (env) => {
				seen.push(env.CODEX_HOME);
				return out("Logged in using ChatGPT");
			},
		});
		const req = await lane.requirement();
		expect(req).toEqual({
			scope: "host",
			id: codexSlotResourceId("/fleet/codex"),
			amount: 1,
		});
		expect(defs).toHaveLength(1);
		expect(defs[0]).toMatchObject({ capacity: 1n, accounting: "slot" });
		expect(seen).toEqual(["/fleet/codex"]);
		// Idempotent: a second call rewrites nothing.
		await lane.requirement();
		expect(defs).toHaveLength(1);
	});

	test("an API key lifts the limit", async () => {
		const { ledger, defs } = fakeLedger();
		const lane = new CodexLane({
			ledger,
			env: () => ({ CODEX_HOME: "/fleet/codex" }),
			run: async () => out("Logged in using an API key - sk-***x"),
		});
		expect(await lane.requirement()).toBeNull();
		expect(defs).toHaveLength(0);
	});

	test("a failed or unreadable status keeps the limit at 1", async () => {
		const { ledger } = fakeLedger();
		const lane = new CodexLane({
			ledger,
			env: () => ({ CODEX_HOME: "/fleet/codex" }),
			run: async () => {
				throw new Error("spawn codex ENOENT");
			},
		});
		expect(await lane.authMode()).toBe("unknown");
		expect(await lane.requirement()).not.toBeNull();
	});

	test("the detected mode is cached until the ttl, and per home", async () => {
		const { ledger } = fakeLedger();
		let calls = 0;
		let now = 0;
		let home = "/a";
		const lane = new CodexLane({
			ledger,
			env: () => ({ CODEX_HOME: home }),
			now: () => now,
			ttlMs: 1000,
			run: async () => {
				calls++;
				return out("Logged in using ChatGPT");
			},
		});
		await lane.authMode();
		await lane.authMode();
		expect(calls).toBe(1);
		now = 1500;
		await lane.authMode();
		expect(calls).toBe(2);
		home = "/b";
		await lane.authMode();
		expect(calls).toBe(3);
	});

	test("a disabled or wider definition is restored to one slot", async () => {
		const { ledger, defs } = fakeLedger();
		const id = codexSlotResourceId("/fleet/codex");
		defs.push({
			id,
			capacity: 3n,
			enabled: true,
			draining: false,
			version: 4n,
		});
		const lane = new CodexLane({
			ledger,
			env: () => ({ CODEX_HOME: "/fleet/codex" }),
			run: async () => out("Logged in using ChatGPT"),
		});
		await lane.requirement();
		expect(defs[0]).toMatchObject({ capacity: 1n, version: 4n });
	});
});
